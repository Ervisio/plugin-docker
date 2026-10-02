import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setSdk } from '../src/sdk.ts';
import { resetEnvState, setEnv, setKnownEnvs } from '../src/api/environments.ts';
import { download, upload, resetEngine } from '../src/api/engine.ts';
import { HELPER_IMAGE } from '../src/api/volumes.ts';

const manifest = JSON.parse(readFileSync(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));
const cap = manifest.capabilities;
type Cmd = { name: string; remote?: string; argv: string[] };

test('the manifest has the rules of every feature branch', () => {
  const http = cap.http[0];
  const rules = http.rules.map((r: { methods: string[]; path: string }) => `${r.methods.join(',')} ${r.path}`);
  assert.ok(rules.some((r: string) => r.endsWith('/images/get')), 'images/get');
  assert.ok(rules.some((r: string) => r.startsWith('POST') && r.endsWith('/images/load')), 'images/load');
  assert.ok(rules.some((r: string) => r.startsWith('PUT') && r.includes('archive')), 'PUT archive');
  assert.equal(http.maxUpload, 1099511627776);
  assert.equal(http.remote, 'docker');
  assert.ok(cap.jobs.length > 0 && cap.notify === true);
  const cmds: Cmd[] = cap.commands;
  for (const n of ['shell', 'attach', 'compose-up', 'compose-ls', 'git-clone', 'compose-up-git', 'volume-backup']) assert.ok(cmds.some((c) => c.name === n), n);
});

test('commands that can reach another host carry remote and {env}; the rest are local on purpose', () => {
  const cmds: Cmd[] = cap.commands;
  for (const c of cmds) {
    if (c.remote) {
      assert.equal(c.remote, 'docker', c.name);
      assert.ok(c.argv.includes('{env}'), `${c.name} names {env}`);
    } else if (c.argv[0] === 'docker') {
      // Jobs and Git stacks only: they run on this server, the UI hides them on another host.
      assert.ok(c.argv.includes('unix:///var/run/docker.sock'), `${c.name} is the local socket`);
      assert.match(c.name, /^(compose-.*-git|container-redeploy|volume-backup|volume-check)$/, c.name);
    }
  }
});

test('scheduled backups and browser backups use the same helper image', () => {
  const backup = (cap.commands as Cmd[]).find((c) => c.name === 'volume-backup')!;
  assert.ok(backup.argv.includes(HELPER_IMAGE));
});

test('downloads and uploads go to the open environment', async () => {
  resetEnvState();
  resetEngine();
  const seen: { kind: string; env?: string }[] = [];
  setSdk({
    api: {
      http: async (_n: string, req: { env?: string }) => ({ status: 200, headers: {}, body: JSON.stringify({ ApiVersion: '1.43' }), json: () => ({ ApiVersion: '1.43' }), bytes: () => new Uint8Array(), req }),
      download: async (_n: string, req: { env?: string }) => { seen.push({ kind: 'download', env: req.env }); return {}; },
      upload: (_n: string, req: { env?: string }) => { seen.push({ kind: 'upload', env: req.env }); return Promise.resolve({}); },
    },
  } as never);
  setKnownEnvs([{ id: 'env-aaaaaaaa', name: 'vps', kind: 'ssh' }] as never);
  setEnv('env-aaaaaaaa');
  await download('/images/get', { names: 'a' }, 'a.tar');
  await upload('POST', '/images/load', {}, new Blob(['x']));
  setEnv(undefined);
  resetEngine();
  await download('/images/get', { names: 'a' }, 'a.tar');
  assert.deepEqual(seen, [{ kind: 'download', env: 'env-aaaaaaaa' }, { kind: 'upload', env: 'env-aaaaaaaa' }, { kind: 'download', env: undefined }]);
});
