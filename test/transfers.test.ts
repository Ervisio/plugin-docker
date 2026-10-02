import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { listTar, parseTar } from '../src/api/origin.ts';
import { tarBlob, tarParts, writeTar } from '../src/api/tar.ts';
import { backupName, helperSpec, isHelper, lifetimeFor, restoreRoot, HELPER_LABEL } from '../src/api/volumes.ts';
import { exportName, parseLoaded } from '../src/views/resources/transferNames.ts';
import { packPicked } from '../src/views/build/tar.ts';

const enc = new TextEncoder();

test('tarBlob keeps a Blob as a part and reads back like writeTar', async () => {
  const body = new Blob([new Uint8Array(1500).fill(7)]);
  const blob = tarBlob([{ name: 'a/b.bin', data: body, mtime: 1700000000 }, { name: 'd/' }]);
  assert.equal(blob.size % 512, 0);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const files = parseTar(bytes);
  assert.deepEqual(files.map((f) => [f.name, f.data.length]), [['a/b.bin', 1500]]);
  assert.deepEqual(listTar(bytes).map((e) => e.name), ['a/b.bin', 'd/']);
  // same bytes as the in-memory writer
  const mem = writeTar([{ name: 'a/b.bin', data: new Uint8Array(1500).fill(7), mtime: 1700000000 }, { name: 'd/' }]);
  assert.deepEqual(bytes, mem);
});

test('a size of 8 GiB or more is written in base-256 and read back', () => {
  const huge = 9 * 1024 ** 3 + 5;
  // tarParts puts the header first; the data Blob only has to report its size.
  const head = tarParts([{ name: 'huge.bin', data: { size: huge } as unknown as Blob }])[0] as Uint8Array;
  assert.equal(head[124], 0x80);
  assert.equal(listTar(head)[0].size, huge);
});

test('names of exports and backups', () => {
  assert.equal(exportName(['busybox:1.36']), 'busybox-1.36.tar');
  assert.equal(exportName(['ghcr.io/a/b:latest']), 'ghcr.io-a-b-latest.tar');
  assert.match(exportName(['a:1', 'b:2']), /^ervisio-images-\d{8}\.tar$/);
  assert.match(exportName(['sha256:' + 'a'.repeat(64)]), /^ervisio-images-/);
  assert.equal(backupName('my vol/1', new Date('2026-10-02T10:00:00Z')), 'my_vol_1-20261002.tar');
});

test('parseLoaded finds the images Docker reports', () => {
  assert.deepEqual(parseLoaded('Loaded image: busybox:1.36\n'), ['busybox:1.36']);
  assert.deepEqual(parseLoaded('Loaded image ID: sha256:abc\nsomething\nLoaded image: a/b:2\n'), ['sha256:abc', 'a/b:2']);
  assert.deepEqual(parseLoaded('nothing'), []);
});

test('the helper container is read-only for browse and backup, has no network and removes itself', () => {
  const ro = helperSpec('busybox:1.37', 'vol', 'ro', 'backup', 600, 1_000_000);
  assert.equal(ro.HostConfig.Mounts[0].ReadOnly, true);
  assert.equal(ro.HostConfig.Mounts[0].Target, '/volume');
  assert.equal(ro.HostConfig.Mounts[0].VolumeOptions.NoCopy, true);
  assert.equal(ro.HostConfig.AutoRemove, true);
  assert.equal(ro.HostConfig.NetworkMode, 'none');
  assert.equal(ro.Labels[HELPER_LABEL], 'volume');
  assert.equal(ro.Labels['io.ervisio.helper.expires'], '1600');
  assert.deepEqual(ro.Cmd, ['sleep', '600']);
  assert.equal(helperSpec('i', 'v', 'rw', 'restore', 60).HostConfig.Mounts[0].ReadOnly, false);
  assert.ok(isHelper({ Labels: { [HELPER_LABEL]: 'volume' } }));
  assert.ok(!isHelper({ Labels: null }));
});

test('a backup helper lives long enough for the volume', () => {
  assert.equal(lifetimeFor('backup', 0), 300 + 20 * 1024);
  assert.equal(lifetimeFor('backup', 200 * 1024 * 1024), 500);
  assert.equal(lifetimeFor('backup', 1024 ** 5), 86400);
  assert.equal(lifetimeFor('browse', 5), 1800);
});

test('restoreRoot sends a backup (top folder volume/) to / and other tars into /volume, also when gzipped', async () => {
  const backup = writeTar([{ name: 'volume/' }, { name: 'volume/a.txt', data: enc.encode('x') }]);
  const plain = writeTar([{ name: 'a.txt', data: enc.encode('x') }, { name: 'sub/', mode: 0o755 }]);
  const dotted = writeTar([{ name: './' }, { name: './a.txt', data: enc.encode('x') }]);
  assert.equal(await restoreRoot(new Blob([backup as BlobPart])), '/');
  assert.equal(await restoreRoot(new Blob([plain as BlobPart])), '/volume');
  assert.equal(await restoreRoot(new Blob([dotted as BlobPart])), '/volume');
  assert.equal(await restoreRoot(new Blob([gzipSync(backup)])), '/');
  assert.equal(await restoreRoot(new Blob([gzipSync(plain)])), '/volume');
  assert.equal(await restoreRoot(new Blob([enc.encode('not a tar at all')])), undefined);
  assert.equal(await restoreRoot(new Blob([])), undefined);
});

test('packPicked packs files as a Blob and gzips small contexts', async () => {
  const f = new File(['#!/bin/sh\necho hi\n'], 'run.sh', { lastModified: 1700000000000 });
  const g = new File([new Uint8Array(10)], 'data.bin');
  const raw = await packPicked([{ path: 'run.sh', file: f }, { path: 'x/data.bin', file: g }], 0);
  const files = parseTar(new Uint8Array(await raw.arrayBuffer()));
  assert.deepEqual(files.map((x) => x.name), ['run.sh', 'x/data.bin']);
  assert.equal(listTar(new Uint8Array(await raw.arrayBuffer()))[0].mode, 0o755);
  const gz = await packPicked([{ path: 'run.sh', file: f }], 1 << 20);
  assert.equal(new Uint8Array(await gz.slice(0, 2).arrayBuffer())[0], 0x1f);
});

test('every string of the transfers, files and build areas exists in English and Italian', async () => {
  for (const area of ['transfers', 'files', 'build', 'customtemplates', 'backup', 'container']) {
    const m = (await import(`../src/i18n/areas/${area}.ts`)).default as { en: Record<string, string>; it: Record<string, string> };
    assert.deepEqual(Object.keys(m.en).sort(), Object.keys(m.it).sort(), area);
  }
});
