import test from 'node:test';
import assert from 'node:assert/strict';
import { originCandidates, originOf, parseTar, rewriteBinds, portainerStackId, envFileNames } from '../src/api/origin.ts';

const enc = new TextEncoder();
function tarEntry(name: string, body: string, type = '0'): Uint8Array {
  const data = enc.encode(body);
  const h = new Uint8Array(512);
  h.set(enc.encode(name).subarray(0, 100), 0);
  h.set(enc.encode('0000644\0'), 100);
  h.set(enc.encode(data.length.toString(8).padStart(11, '0') + '\0'), 124);
  h[156] = type.charCodeAt(0);
  h.set(enc.encode('ustar\0'), 257);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const x of h) sum += x;
  h.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
  const pad = new Uint8Array(Math.ceil(data.length / 512) * 512);
  pad.set(data);
  return Uint8Array.from([...h, ...pad]);
}
const end = new Uint8Array(1024);
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));

test('parseTar reads regular files, GNU long names and pax paths', () => {
  const long = 'a/'.repeat(80) + 'f.yml';
  const t = cat(tarEntry('docker-compose.yml', 'services: {}\n'), tarEntry('d/', '', '5'), tarEntry('././@LongLink', long + '\0', 'L'), tarEntry('short', 'x\n'), tarEntry('p', 'path=ok\n'.length ? `${'path=pax/name.env'.length + 4} path=pax/name.env\n` : '', 'x'), tarEntry('zz', 'é\n'), end);
  const f = parseTar(t);
  assert.deepEqual(f.map((x) => x.name), ['docker-compose.yml', long, 'pax/name.env']);
  assert.equal(new TextDecoder().decode(f[2].data), 'é\n');
});

test('parseTar enforces the caps', () => {
  assert.throws(() => parseTar(cat(tarEntry('a', 'x'.repeat(100)), end), 50), /too large/);
  assert.throws(() => parseTar(cat(tarEntry('a', 'x'), tarEntry('b', 'x'), end), 1000, 1), /too many/);
});

const portainer = { Id: 'p'.repeat(64), Names: ['/portainer'], Image: 'portainer/portainer-ce:latest', Mounts: [{ Type: 'volume', Name: 'portainer_data', Source: '/var/lib/docker/volumes/portainer_data/_data', Destination: '/data' }] };
const app = { Id: 'a'.repeat(64), Names: ['/s-web-1'], Image: 'busybox', Labels: { 'com.docker.compose.project': 's', 'com.docker.compose.service': 'web' }, Mounts: [{ Type: 'bind', Source: '/data/compose/7/data', Destination: '/data' }, { Type: 'bind', Source: '/srv/cfg', Destination: '/cfg' }] };
const same = { Id: 'c'.repeat(64), Names: ['/dockge'], Image: 'louislam/dockge', Mounts: [{ Type: 'bind', Source: '/opt/stacks', Destination: '/opt/stacks' }] };

test('origin detection prefers Portainer, skips the project and same-path binds', () => {
  const c = originCandidates('/data/compose/7', 's', [app, same, portainer]);
  assert.equal(c.length, 1);
  const o = originOf(c[0], '/data/compose/7');
  assert.deepEqual([o.kind, o.container, o.stackId, o.volume, o.hostPath], ['portainer', 'portainer', 7, 'portainer_data', '/var/lib/docker/volumes/portainer_data/_data/compose/7']);
  assert.equal(originCandidates('/opt/stacks/x', 'x', [same]).length, 0);
  const other = { ...portainer, Id: 'o'.repeat(64), Names: ['/yacht'], Image: 'selfhostedpro/yacht', Mounts: [{ Type: 'bind', Source: '/srv/yacht', Destination: '/config' }] };
  assert.equal(originOf(originCandidates('/config/compose/x', 'x', [other])[0], '/config/compose/x').kind, 'container');
  assert.equal(portainerStackId('/data/compose/12'), 12);
  assert.deepEqual(envFileNames(undefined, '/data/compose/7'), ['/data/compose/7/stack.env', '/data/compose/7/.env']);
});

test('rewriteBinds handles short and long syntax, keeps comments', () => {
  const text = `# my stack
services:
  web:
    image: busybox
    env_file: ./web.env
    volumes:
      - ./data:/data   # keep
      - ./cfg/:/cfg:ro
      - ../up:/up
      - /abs:/abs
      - named:/n
      - type: bind
        source: ./long
        target: /long
      - type: volume
        source: ./nope
        target: /v
      - \${X}/a:/x
volumes:
  named: {}
`;
  const running = { ...app, Mounts: [...app.Mounts, { Type: 'bind', Source: '/data/compose/7/long', Destination: '/long' }] };
  const r = rewriteBinds(text, '/data/compose/7', [running]);
  assert.match(r.text, /^# my stack/);
  assert.match(r.text, /- \/data\/compose\/7\/data:\/data +# keep/);
  assert.match(r.text, /- \/srv\/cfg:\/cfg:ro/);
  assert.match(r.text, /- \/data\/compose\/up:\/up/);
  assert.match(r.text, /source: \/data\/compose\/7\/long/);
  assert.match(r.text, /source: \.\/nope/);
  assert.match(r.text, /- \/abs:\/abs/);
  assert.deepEqual(r.changes.map((c) => [c.from, c.to, c.source]), [
    ['./data', '/data/compose/7/data', 'container'],
    ['./cfg/', '/srv/cfg', 'container'],
    ['../up', '/data/compose/up', 'path'],
    ['./long', '/data/compose/7/long', 'container'],
  ]);
  assert.deepEqual(r.warnings.map((w) => w.kind), ['variable']);
  assert.deepEqual(r.envFiles, ['web.env']);
});

test('rewriteBinds leaves a file without relative binds unchanged', () => {
  const t = 'services:\n  a:\n    image: x\n    volumes: [ "v:/v" ]\n';
  assert.equal(rewriteBinds(t, '/d', []).text, t);
});
