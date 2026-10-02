import test from 'node:test';
import assert from 'node:assert/strict';
import { listTar, parseTar } from '../src/api/origin.ts';
import { writeTar } from '../src/api/tar.ts';
import { demux, entriesFromTar, modeString, normalizePath, parentOf, joinPath, parseLs, validName, sortEntries } from '../src/api/files.ts';
import { checkRef, parseChanges } from '../src/api/commit.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();

test('writeTar output is read back by parseTar and listTar', () => {
  const long = 'deep/'.repeat(30) + 'file.txt';
  const tar = writeTar([
    { name: 'hello.txt', data: enc.encode('hello é\n'), mode: 0o600, mtime: 1700000000 },
    { name: 'sub/', mode: 0o750 },
    { name: long, data: new Uint8Array(1000).fill(65) },
    { name: 'empty', data: new Uint8Array(0) },
  ]);
  assert.equal(tar.length % 512, 0);
  const files = parseTar(tar);
  assert.deepEqual(files.map((f) => f.name), ['hello.txt', long, 'empty']);
  assert.equal(dec.decode(files[0].data), 'hello é\n');
  assert.equal(files[1].data.length, 1000);
  const heads = listTar(tar);
  assert.deepEqual(heads.map((h) => [h.name, h.type]), [['hello.txt', '0'], ['sub/', '5'], [long, '0'], ['empty', '0']]);
  assert.equal(heads[0].mode, 0o600);
  assert.equal(heads[0].mtime, 1700000000);
  assert.equal(heads[1].mode, 0o750);
  assert.equal(heads[0].size, enc.encode('hello é\n').length);
});

test('a tar made by GNU tar is listed (directory prefix ./)', () => {
  const tar = writeTar([{ name: './' }, { name: './etc/' }, { name: './etc/passwd', data: enc.encode('x') }, { name: './hosts', data: enc.encode('yy') }]);
  const e = entriesFromTar(tar);
  assert.deepEqual(e.map((x) => [x.name, x.kind, x.size]).sort(), [['etc', 'dir', 0], ['hosts', 'file', 2]]);
});

test('parseLs reads GNU and busybox lines, links and devices', () => {
  const text = [
    'total 12',
    'drwxr-xr-x    1 root     root          4096 2026-04-15 18:09:41.000000000 +0000 .',
    'drwxr-xr-x    1 root     root          4096 2026-10-02 16:25:35.123456789 +0200 ..',
    '-rw-r--r--    1 root     root            17 2026-10-02 16:38:03.000000000 +0000 with space.txt',
    'lrwxrwxrwx    1 root     root             9 2026-10-02 16:25:35.000000000 +0000 lnk -> hello.txt',
    'crw-rw-rw-    1 root     root          1,   3 2026-10-02 16:25:35.000000000 +0000 null',
    'drwxrwxrwt 2 root root 4096 2026-04-15 18:09:41.000000000 +0000 tmp',
  ].join('\n');
  const e = parseLs(text);
  assert.deepEqual(e.map((x) => [x.name, x.kind, x.size]), [['with space.txt', 'file', 17], ['lnk', 'link', 9], ['null', 'other', 3], ['tmp', 'dir', 4096]]);
  assert.equal(e[1].target, 'hello.txt');
  assert.equal(e[0].mtime, Date.parse('2026-10-02T16:38:03+00:00'));
  assert.equal(e[3].owner, 'root');
  assert.deepEqual(sortEntries(e).map((x) => x.name), ['tmp', 'lnk', 'null', 'with space.txt']);
});

test('demux splits stdout and stderr frames', () => {
  const frame = (k: number, s: string) => {
    const b = enc.encode(s);
    const h = new Uint8Array(8);
    h[0] = k;
    new DataView(h.buffer).setUint32(4, b.length);
    return [...h, ...b];
  };
  const out = demux(Uint8Array.from([...frame(1, 'one '), ...frame(2, 'err'), ...frame(1, 'two')]));
  assert.equal(out.stdout, 'one two');
  assert.equal(out.stderr, 'err');
});

test('paths and names', () => {
  assert.equal(normalizePath('/a//b/./c/../d/'), '/a/b/d');
  assert.equal(normalizePath('/../..'), '/');
  assert.equal(parentOf('/a/b'), '/a');
  assert.equal(parentOf('/a'), '/');
  assert.equal(joinPath('/', 'x'), '/x');
  assert.equal(joinPath('/a/', 'x'), '/a/x');
  assert.ok(validName('a b.txt') && !validName('a/b') && !validName('..') && !validName('') && !validName('x'.repeat(256)));
  assert.equal(modeString(0o755), 'rwxr-xr-x');
  assert.equal(modeString(0o1777), 'rwxrwxrwt');
  assert.equal(modeString(0o4755), 'rwsr-xr-x');
});

test('commit helpers', () => {
  assert.equal(checkRef('myapp', 'latest'), '');
  assert.equal(checkRef('me/my-app_1.2', 'v1'), '');
  assert.equal(checkRef('registry.local:5000/me/app', ''), '');
  assert.equal(checkRef('', 'latest'), 'commit.err.repo');
  assert.equal(checkRef('MyApp', 'latest'), 'commit.err.repo');
  assert.equal(checkRef('my app', 'latest'), 'commit.err.repo');
  assert.equal(checkRef('myapp', 'bad tag'), 'commit.err.tag');
  const ok = parseChanges('CMD ["a","b"]\n\n# note\nENV A=1\nexpose 80');
  assert.deepEqual(ok.lines, ['CMD ["a","b"]', 'ENV A=1', 'expose 80']);
  assert.equal(ok.badLine, undefined);
  assert.equal(parseChanges('CMD x\nRUN apk add y').badLine, 2);
  assert.equal(parseChanges('CMD').badLine, 1);
});
