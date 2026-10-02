import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setSdk } from '../src/sdk.ts';
import { watchDownload, describeDone } from '../src/api/downloads.ts';
import { beginRestore, forgetRestore, interruptedFor, planRestart, readJournal, releaseRestore } from '../src/api/restoreJournal.ts';
import { fsx } from '../src/api/compose.ts';
import { setEnv, setKnownEnvs } from '../src/api/environments.ts';
import { appOrigin } from '../src/api/appOrigin.ts';

const manifest = JSON.parse(readFileSync(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));

test('the manifest asks for core 0.5.0 and every step timeout fits its job and the core limit', () => {
  assert.equal(manifest.minCore, '0.5.0');
  for (const job of manifest.capabilities.jobs) {
    for (const s of job.steps) {
      if (s.timeoutSec === undefined) continue;
      assert.ok(s.command, `${job.name}.${s.id}: only command steps have a timeout`);
      assert.ok(s.timeoutSec <= 21600 && s.timeoutSec <= (job.timeoutSec ?? 300), `${job.name}.${s.id}`);
    }
  }
});

test('scheduled volume backups get 6 hours and pull the helper image first', () => {
  for (const job of manifest.capabilities.jobs.filter((j: { name: string }) => j.name.startsWith('volume-backup-'))) {
    assert.equal(job.timeoutSec, 21600, job.name);
    assert.equal(job.steps[0].id, 'image', job.name);
    assert.equal(job.steps[0].command, 'volume-image');
    const run = job.steps.find((s: { id: string }) => s.id === 'run');
    assert.equal(run.timeoutSec, 21600);
  }
  const img = manifest.capabilities.commands.find((c: { name: string }) => c.name === 'volume-image');
  assert.ok(img.argv.includes('busybox:1.37'));
  assert.match(img.argv[2], /image inspect/);
  assert.match(img.argv[2], /pull/);
});

test('Git and redeploy jobs give the pull and the up step their own time', () => {
  for (const name of ['git-redeploy', 'git-poll-n', 'stack-redeploy']) {
    const job = manifest.capabilities.jobs.find((j: { name: string }) => j.name === name);
    const pull = job.steps.find((s: { id: string }) => s.id === 'pull');
    const up = job.steps.find((s: { id: string }) => s.id === 'up');
    assert.ok(pull.timeoutSec >= 600 && up.timeoutSec >= 600, name);
  }
});

test('watchDownload ends once: by onDone, or by the fallback when nothing comes', async () => {
  const seen: unknown[] = [];
  const a = watchDownload((r) => seen.push(r), 20);
  a.armed();
  a.onDone({ ok: true, bytes: 5 });
  a.onDone({ ok: false, bytes: 1 });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(seen, [{ ok: true, bytes: 5 }]);

  const b = watchDownload((r) => seen.push(r ?? 'timeout'), 10);
  b.armed();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(seen[1], 'timeout');

  const c = watchDownload(() => seen.push('never'), 10);
  c.armed();
  c.abort();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, 2);
});

test('describeDone gives the size on success and the reason on failure', () => {
  assert.equal(describeDone(undefined), undefined);
  assert.deepEqual(describeDone({ ok: true, bytes: 3 * 1024 * 1024 }), { ok: true, size: '3 MB' });
  assert.deepEqual(describeDone({ ok: false, bytes: 0, error: 'cancelled' }), { ok: false, size: '0 B', error: 'cancelled' });
});

test('appOrigin comes from sdk.appOrigin and falls back when the console is older', () => {
  setSdk({ appOrigin: 'https://box.example:9090/' } as never);
  assert.equal(appOrigin(), 'https://box.example:9090');
  setSdk({} as never);
  assert.equal(appOrigin(), '');
});

test('a restore record lists what it stopped; a running page owns it; planRestart skips what runs or is gone', async () => {
  const store = new Map<string, string>();
  setSdk({
    files: {
      read: async (p: string) => { if (!store.has(p)) throw Object.assign(new Error('not_found'), { code: 'not_found' }); return store.get(p)!; },
      write: async (p: string, d: string) => { store.set(p, d); },
    },
  } as never);
  const id = await beginRestore('data', [{ id: 'a', name: 'web' }, { id: 'b', name: 'db' }, { id: 'c', name: 'old' }], undefined);
  const all = await readJournal();
  assert.equal(all.length, 1);
  // while this page runs the restore it is not "interrupted"
  assert.equal(interruptedFor(all, undefined).length, 0);
  releaseRestore(id);
  assert.equal(interruptedFor(all, undefined).length, 1);
  assert.equal(interruptedFor(all, 'env-aaaaaaaa').length, 0);
  const plan = planRestart(all[0], [{ Id: 'a', State: 'exited' }, { Id: 'b', State: 'running' }]);
  assert.deepEqual(plan, { start: [{ id: 'a', name: 'web' }], gone: 1, running: 1 });
  await forgetRestore(id);
  assert.equal((await readJournal()).length, 0);
});

test('stack files of a paired Ervisio server are read and written with { env }; other environments call plainly', async () => {
  const calls: { fn: string; path: string; opts: unknown }[] = [];
  const rec = (fn: string) => async (path: string, ...rest: unknown[]) => { calls.push({ fn, path, opts: rest[rest.length - 1] }); return fn === 'list' ? [] : ''; };
  setSdk({ files: { read: rec('read'), list: rec('list'), write: rec('write'), mkdir: rec('mkdir'), remove: rec('remove') } } as never);
  setKnownEnvs([
    { id: 'env-bbbbbbbb', name: 'nas', kind: 'ervisio' },
    { id: 'env-aaaaaaaa', name: 'edge', kind: 'ssh' },
  ] as never);
  setEnv(undefined);
  await fsx.read('/opt/stacks/web/compose.yaml');
  setEnv('env-aaaaaaaa');
  await fsx.write('/opt/stacks/.envs/env-aaaaaaaa/web/.env', 'A=1');
  setEnv('env-bbbbbbbb');
  await fsx.write('/opt/stacks/web/.env', 'A=1');
  await fsx.list('/opt/stacks');
  assert.equal(calls[0].opts, undefined);
  assert.equal(calls[1].opts, undefined);
  assert.deepEqual(calls[2].opts, { env: 'env-bbbbbbbb' });
  assert.deepEqual(calls[3].opts, { env: 'env-bbbbbbbb' });
  setEnv(undefined);
});
