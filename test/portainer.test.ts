import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BoltDB, BoltError, idKey } from '../src/api/bolt.ts';
import { PortainerDbError, intervalSeconds, mustacheToCompose, readPortainerDb, refName } from '../src/api/portainerDb.ts';

// test/fixtures/portainer.db was made by running portainer/portainer-ce 2.45.1 as ervta-portainer, initializing the
// admin through its API, creating a compose stack with variables, two Git stacks (one with a login), a registry, a
// custom template and an agent environment, then stopping the container and copying /data/portainer.db.
const file = new Uint8Array(readFileSync(new URL('./fixtures/portainer.db', import.meta.url)));

test('BoltDB lists the buckets of a real Portainer file', () => {
  const db = new BoltDB(file);
  assert.equal(db.pageSize, 4096);
  const names = db.root.bucketNames();
  for (const n of ['stacks', 'registries', 'customtemplates', 'endpoints', 'version', 'sources', 'workflows']) assert.ok(names.includes(n), n);
  assert.equal(db.root.bucket('nope'), null);
});

test('BoltDB reads values by key, with integer ids as 8 byte big endian', () => {
  const db = new BoltDB(file);
  const stacks = db.root.bucket('stacks')!;
  assert.equal(stacks.pairs().length, 3);
  const one = stacks.get(idKey(1));
  assert.ok(one);
  assert.equal(JSON.parse(new TextDecoder().decode(one)).Name, 'ervta-pstack');
  assert.equal(stacks.get(idKey(99)), null);
});

test('BoltDB refuses files that are not BoltDB, and damaged ones, without looping', () => {
  assert.throws(() => new BoltDB(new Uint8Array(100)), BoltError);
  assert.throws(() => new BoltDB(new Uint8Array(8192)), BoltError);
  const bad = file.slice();
  // Point a branch/leaf at nonsense: wipe the second meta and the first page's flags.
  bad.fill(0xff, 4096 + 16, 4096 + 80);
  const broken = new Uint8Array(bad);
  broken.fill(0xff, 16, 80);
  assert.throws(() => new BoltDB(broken), BoltError);
  // A truncated file: the root page lies past the end.
  const cut = file.slice(0, 8192);
  assert.throws(() => new BoltDB(cut).root.bucketNames(), BoltError);
});

test('readPortainerDb extracts stacks, Git stacks, registries, templates and environments', () => {
  const d = readPortainerDb(file);
  assert.match(d.version, /^2\./);

  assert.deepEqual(d.stacks.map((s) => s.name), ['ervta-pstack', 'ervta-pgit', 'ervta-pprivate']);
  const plain = d.stacks[0];
  assert.equal(plain.kind, 'compose');
  assert.equal(plain.projectPath, '/data/compose/1');
  assert.equal(plain.entryPoint, 'docker-compose.yml');
  assert.deepEqual(plain.env, [{ key: 'GREETING', value: 'hello portainer' }, { key: 'SECRET_KEY', value: 's3cr3t' }]);
  assert.equal(plain.git, undefined);

  const git = d.stacks[1];
  assert.equal(git.git?.url, 'http://172.17.0.12:9429/public/web');
  assert.equal(git.git?.ref, 'main');
  assert.equal(git.git?.file, 'deploy/compose.yaml');
  assert.equal(git.git?.username, undefined);
  assert.equal(git.autoUpdateSeconds, 300);
  assert.deepEqual(git.env, [{ key: 'MODE', value: 'git' }]);

  const priv = d.stacks[2];
  assert.equal(priv.git?.username, 'git');
  assert.equal(priv.git?.password, 's3cr3t-token');

  assert.equal(d.registries.length, 1);
  assert.deepEqual({ ...d.registries[0] }, { id: 1, name: 'ervta-registry', kind: 'Custom', server: 'registry.example.test:5000', username: 'ervta', password: 'reg-pass-123', authentication: true });

  assert.equal(d.templates.length, 1);
  assert.equal(d.templates[0].title, 'Ervta whoami');
  assert.deepEqual(d.templates[0].variables, [{ name: 'PORT', label: 'Port', default: '8099', description: 'Host port' }]);
  assert.equal(d.templates[0].projectPath, '/data/custom_templates/1');

  const local = d.endpoints.find((e) => e.name === 'local')!;
  assert.equal(local.maps, 'this-machine');
  const agent = d.endpoints.find((e) => e.kind === 'agent')!;
  assert.equal(agent.maps, 'portainer-agent');
  assert.match(agent.address ?? '', /^172\.17\.0\.\d+:9001$/);
  assert.equal(agent.tls, true);
});

test('a database whose values are not JSON is reported as encrypted', () => {
  // Same file with the values of the "stacks" bucket scrambled in place.
  const copy = file.slice();
  const text = new TextEncoder().encode('{"Id":1,"Name":"ervta-pstack"');
  for (let i = 0; i + text.length < copy.length; i++) {
    let hit = true;
    for (let j = 0; j < text.length; j++) if (copy[i + j] !== text[j]) { hit = false; break; }
    if (hit) for (let j = 0; j < text.length; j++) copy[i + j] = 0x80 + (j % 100);
  }
  assert.throws(() => readPortainerDb(copy), (e) => e instanceof PortainerDbError && e.code === 'encrypted');
});

// test/fixtures/portainer-2.19.db: the same, made with portainer/portainer-ce 2.19.5, which keeps a Git stack's
// repository in the stack itself (GitConfig) instead of the sources/workflows buckets of 2.4x.
const old = new Uint8Array(readFileSync(new URL('./fixtures/portainer-2.19.db', import.meta.url)));

test('an older Portainer (2.19): GitConfig inside the stack, Docker Hub registry, template with {{ }} variables', () => {
  const d = readPortainerDb(old);
  assert.equal(d.version, '2.19.5');
  assert.deepEqual(d.stacks.map((s) => s.name), ['ervta-oldplain', 'ervta-oldgit']);
  const g = d.stacks[1];
  assert.equal(g.git?.url, 'http://172.17.0.12:9429/private/api.git');
  assert.equal(g.git?.ref, 'main');
  assert.equal(g.git?.file, 'deploy/compose.yaml');
  assert.equal(g.git?.username, 'git');
  assert.equal(g.git?.password, 's3cr3t-token');
  assert.equal(g.autoUpdateSeconds, 3600);
  assert.deepEqual(g.env, [{ key: 'B', value: '2' }]);
  assert.equal(d.registries[0].kind, 'Docker Hub');
  assert.equal(d.registries[0].server, 'docker.io');
  assert.equal(d.registries[0].username, 'ervtauser');
  assert.equal(d.templates[0].title, 'Old tpl');
  assert.equal(d.endpoints.length, 1);
});

test('intervals and template placeholders', () => {
  assert.equal(intervalSeconds('5m'), 300);
  assert.equal(intervalSeconds('1h30m'), 5400);
  assert.equal(intervalSeconds('24h'), 86400);
  assert.equal(intervalSeconds('soon'), undefined);
  assert.equal(mustacheToCompose('ports: ["{{ PORT }}:80", "{{HOST}}"]'), 'ports: ["${PORT}:80", "${HOST}"]');
});
