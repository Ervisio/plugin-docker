import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildQuery, parsePairs } from '../src/views/build/options.ts';
import { packTar } from '../src/views/build/tar.ts';

const enc = (s: string) => new TextEncoder().encode(s);

test('packTar writes an archive that tar can list and extract', () => {
  const long = 'a'.repeat(60) + '/' + 'b'.repeat(60) + '/' + 'c'.repeat(60) + '/file.txt';
  const tar = packTar([
    { path: 'Dockerfile', data: enc('FROM scratch\n') },
    { path: 'src/main.sh', data: enc('#!/bin/sh\n'), mode: 0o755 },
    { path: long, data: enc('long') },
    { path: 'dir/ünï.txt', data: enc('utf8') },
    { path: 'big.bin', data: new Uint8Array(1500).fill(7) },
  ]);
  assert.equal(tar.length % 512, 0);
  const r = spawnSync('tar', ['-tvf', '-'], { input: tar });
  assert.equal(r.status, 0, r.stderr.toString());
  const out = r.stdout.toString();
  assert.match(out, /Dockerfile/);
  assert.match(out, /-rwxr-xr-x .* src\/main\.sh/);
  assert.ok(out.includes(long));
  assert.ok(out.includes('dir/ünï.txt'));
  assert.match(out, / 1500 .* big\.bin/);
});

test('parsePairs reads NAME=value lines', () => {
  assert.deepEqual(parsePairs('A=1\n\n# note\nB = x=y\n').pairs, { A: '1', B: ' x=y' });
  assert.equal(parsePairs('A=1\nnope').bad, 2);
});

test('buildQuery sends only what was set', () => {
  const base = { tags: [], dockerfile: 'Dockerfile', buildArgs: {}, target: '', noCache: false, pull: false, platform: '', labels: {} };
  assert.deepEqual(buildQuery(base), { rm: '1' });
  const q = buildQuery({ ...base, tags: ['a:1', 'b:2'], dockerfile: 'sub/Dockerfile', buildArgs: { X: '1' }, target: 't', noCache: true, pull: true, platform: 'linux/arm64', labels: { l: 'v' } }, 'https://x/y.git#main');
  assert.deepEqual(q.t, ['a:1', 'b:2']);
  assert.equal(q.remote, 'https://x/y.git#main');
  assert.equal(q.buildargs, '{"X":"1"}');
  assert.equal(q.labels, '{"l":"v"}');
  assert.equal(q.nocache, '1');
  assert.equal(q.pull, '1');
  assert.equal(q.platform, 'linux/arm64');
  assert.equal(q.dockerfile, 'sub/Dockerfile');
  assert.equal(q.target, 't');
});
