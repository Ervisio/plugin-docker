import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setSdk } from '../src/sdk.ts';
import { capsOf, currentEnv, envGeneration, onEnvChange, resetEnvState, setEnv, setKnownEnvs, withEnv } from '../src/api/environments.ts';
import { docker, engineVersion } from '../src/api/engine.ts';
import { createResource } from '../src/api/store.ts';
import { canManageStacks, stackArgs, stackDir, stacksRoot } from '../src/api/compose.ts';
import { healthOf, limitOf } from '../src/api/envHealth.ts';
import { summarize } from '../src/api/envSummary.ts';
import { dayMs, envLabel, matchesEnv, serverQuery, toCsv, EMPTY_FILTER } from '../src/api/activity.ts';
import mergedEn from '../src/i18n/areas/envs.ts';

const ENVS = [
  { id: 'env-aaaaaaaa', name: 'vps', kind: 'ssh' as const },
  { id: 'env-bbbbbbbb', name: 'nas', kind: 'ervisio' as const },
  { id: 'env-cccccccc', name: 'pi', kind: 'portainer-agent' as const },
  { id: 'env-dddddddd', name: 'ci', kind: 'tcp-tls' as const },
];

interface Call { name: string; req: { path: string; env?: string } }
function fakeSdk(answer: (c: Call) => unknown = () => ({})) {
  const calls: Call[] = [];
  const sdk = {
    api: {
      http: async (name: string, req: Call['req']) => {
        const c = { name, req };
        calls.push(c);
        const body = req.path === '/version' ? { Version: '29', ApiVersion: req.env ? '1.43' : '1.50' } : answer(c);
        return { status: 200, headers: {}, body: JSON.stringify(body), json: () => body, bytes: () => new Uint8Array() };
      },
    },
  };
  setSdk(sdk as never);
  return calls;
}

test.beforeEach(() => {
  resetEnvState();
});

test('capabilities depend on the kind', () => {
  assert.deepEqual(capsOf(undefined, undefined), { terminal: true, live: true, stacks: true, stackPrefix: '', remoteFiles: false });
  assert.equal(capsOf('ssh', 'env-aaaaaaaa').stackPrefix, '.envs/env-aaaaaaaa/');
  assert.equal(capsOf('tcp-tls', 'env-dddddddd').terminal, true);
  assert.equal(capsOf('portainer-agent', 'env-cccccccc').terminal, false);
  assert.equal(capsOf('portainer-agent', 'env-cccccccc').live, false);
  assert.equal(capsOf('ssh', 'env-aaaaaaaa').live, true);
  assert.equal(capsOf('portainer-agent', 'env-cccccccc').stacks, true);
  // a paired server keeps its own stack files: nothing to edit here
  assert.equal(capsOf('ervisio', 'env-bbbbbbbb').stacks, false);
  assert.equal(capsOf('ervisio', 'env-bbbbbbbb').stackPrefix, '');
});

test('setEnv only accepts listed environments and bumps the generation once per change', () => {
  setKnownEnvs(ENVS);
  const seen: (string | undefined)[] = [];
  const off = onEnvChange(() => seen.push(currentEnv()));
  assert.equal(setEnv('env-nope'), false, 'an unknown id is this server');
  assert.equal(currentEnv(), undefined);
  assert.equal(setEnv('env-aaaaaaaa'), true);
  assert.equal(setEnv('env-aaaaaaaa'), false);
  const g = envGeneration();
  assert.equal(setEnv(undefined), true);
  assert.equal(envGeneration(), g + 1);
  assert.deepEqual(seen, ['env-aaaaaaaa', undefined]);
  off();
});

test('an environment that disappears from the list sends the plugin back to this server', () => {
  setKnownEnvs(ENVS);
  setEnv('env-dddddddd');
  setKnownEnvs(ENVS.filter((e) => e.id !== 'env-dddddddd'));
  assert.equal(currentEnv(), undefined);
});

test('withEnv adds the current environment to a request', () => {
  setKnownEnvs(ENVS);
  assert.deepEqual(withEnv({ method: 'GET' }), { method: 'GET' });
  setEnv('env-aaaaaaaa');
  assert.deepEqual(withEnv({ method: 'GET' }), { method: 'GET', env: 'env-aaaaaaaa' });
});

test('HTTP calls carry the environment and the API version is negotiated per environment', async () => {
  const calls = fakeSdk(() => []);
  setKnownEnvs(ENVS);
  await docker.get('/containers/json');
  setEnv('env-aaaaaaaa');
  await docker.get('/containers/json');
  await docker.get('/images/json');
  assert.deepEqual(
    calls.map((c) => [c.req.path, c.req.env]),
    [
      ['/version', undefined],
      ['/v1.50/containers/json', undefined],
      ['/version', 'env-aaaaaaaa'],
      ['/v1.43/containers/json', 'env-aaaaaaaa'],
      ['/v1.43/images/json', 'env-aaaaaaaa'],
    ],
  );
  assert.ok(!('env' in calls[1].req), 'the local call has no env key at all');
  assert.equal((await engineVersion(undefined)).ApiVersion, '1.50');
});

test('a store forgets its data when the environment changes and drops an answer that arrives late', async () => {
  setKnownEnvs(ENVS);
  let release: (v: string) => void = () => {};
  let n = 0;
  const store = createResource<string>(
    () => {
      n++;
      return n === 1 ? new Promise<string>((r) => (release = r)) : Promise.resolve(`fresh ${currentEnv()}`);
    },
    { intervalMs: 60000 },
  );
  // no component here: refresh() works without subscribers
  const first = store.refresh();
  setEnv('env-aaaaaaaa');
  release('answer of the old host');
  await first;
  assert.equal(store.peek().data, undefined, 'the late answer was dropped');
  assert.equal(store.peek().loading, true);
  await store.refresh();
  assert.equal(store.peek().data, 'fresh env-aaaaaaaa');
});

test('a global store survives a switch', async () => {
  setKnownEnvs(ENVS);
  const store = createResource<number>(async () => 7, { intervalMs: 60000, global: true });
  await store.refresh();
  setEnv('env-aaaaaaaa');
  assert.equal(store.peek().data, 7);
});

test('stack folders and compose arguments follow the environment', () => {
  setKnownEnvs(ENVS);
  assert.equal(stackDir('web'), '/opt/stacks/web');
  assert.deepEqual(stackArgs('web'), ['web', '']);
  setEnv('env-aaaaaaaa');
  assert.equal(stacksRoot(), '/opt/stacks/.envs/env-aaaaaaaa');
  assert.equal(stackDir('web'), '/opt/stacks/.envs/env-aaaaaaaa/web');
  assert.deepEqual(stackArgs('web'), ['web', '.envs/env-aaaaaaaa/']);
  assert.equal(canManageStacks(), true);
  setEnv('env-bbbbbbbb');
  assert.equal(canManageStacks(), false);
  assert.deepEqual(stackArgs('web'), ['web', '']);
});

test('card health: a fresh answer beats an old failed check; agents and paired servers are limited', () => {
  assert.equal(healthOf('ssh', true, undefined), 'ok');
  assert.equal(healthOf('ssh', false, undefined), 'off');
  assert.equal(healthOf('ssh', false, true), 'ok');
  assert.equal(healthOf('ssh', true, false), 'off');
  assert.equal(healthOf('portainer-agent', true, true), 'limited');
  assert.equal(healthOf('ervisio', true, undefined), 'limited');
  assert.equal(healthOf('local', true, true), 'ok');
  assert.equal(limitOf('tcp-tls'), '');
});

test('summarize counts containers, stacks and the share of CPU and memory', () => {
  const c = (State: string, project?: string) => ({ Id: State + project, State, Labels: project ? { 'com.docker.compose.project': project } : {} }) as never;
  const raw = (cpuTotal: number, sys: number, mem: number) => ({
    cpu_stats: { cpu_usage: { total_usage: 100 + cpuTotal }, system_cpu_usage: 1000 + sys, online_cpus: 2 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    memory_stats: { usage: mem, limit: 1e12 },
  }) as never;
  const s = summarize({ Name: 'h', ServerVersion: '29', NCPU: 4, MemTotal: 1000 } as never, [c('running', 'a'), c('running', 'a'), c('exited', 'b'), c('running')], [raw(50, 100, 100), raw(100, 100, 200)], 1);
  assert.equal(s.running, 3);
  assert.equal(s.stopped, 1);
  assert.equal(s.stacks, 2);
  // one core busy plus two cores busy, on a 4-core host: 3 of 4 = 75%
  assert.equal(Math.round(s.cpu ?? -1), 75);
  assert.equal(Math.round(s.mem ?? -1), 30);
  assert.equal(s.partial, true);
  const idle = summarize({ Name: 'h', ServerVersion: '29', NCPU: 4, MemTotal: 1000 } as never, [c('exited')], [], 1);
  assert.deepEqual([idle.cpu, idle.mem, idle.partial], [0, 0, false]);
});

test('activity filters: day bounds, environment and CSV with spreadsheet formulas neutralised', () => {
  const from = dayMs('2026-10-02', false)!;
  const to = dayMs('2026-10-02', true)!;
  assert.equal(to - from >= 23 * 3600e3 && to - from <= 25 * 3600e3, true);
  assert.equal(dayMs('', false), undefined);
  assert.deepEqual(serverQuery(EMPTY_FILTER), {});
  assert.deepEqual(serverQuery({ ...EMPTY_FILTER, user: ' ann ', action: 'command' }), { user: 'ann', action: 'command' });
  const base = { time: '2026-10-02T10:00:00Z', user: 'ann', source: 'plugin' as const, action: 'http', result: 'ok' as const };
  const names = new Map([['env-aaaaaaaa', 'vps']]);
  assert.equal(matchesEnv({ ...base }, 'local'), true);
  assert.equal(matchesEnv({ ...base, env: 'env-aaaaaaaa' }, 'local'), false);
  assert.equal(matchesEnv({ ...base, env: 'env-aaaaaaaa' }, 'env-aaaaaaaa'), true);
  assert.equal(matchesEnv({ ...base }, ''), true);
  assert.equal(envLabel({ ...base, env: 'env-aaaaaaaa' }, names, 'This server'), 'vps');
  assert.equal(envLabel({ ...base, env: 'env-gone0000' }, names, 'This server'), 'env-gone0000');
  assert.equal(envLabel({ ...base }, names, 'This server'), 'This server');
  const csv = toCsv([{ ...base, target: '=HYPERLINK("x"),a', env: 'env-aaaaaaaa', detail: 'two\nlines' }, { ...base, target: 'POST /v1.43/containers/x/stop' }], names, 'This server');
  const lines = csv.split('\n');
  assert.equal(lines[0], 'time,user,action,target,environment,result,code,detail,origin');
  assert.ok(csv.includes('"\'=HYPERLINK(""x""),a"'), csv);
  assert.ok(csv.includes('"two\nlines"'));
  assert.ok(csv.includes(',This server,'));
});

test('every command that names a Docker host is remote with exactly one {env}, and stack commands take the folder prefix', () => {
  const m = JSON.parse(readFileSync(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));
  const docker = m.capabilities.http.find((h: { name: string }) => h.name === 'docker');
  assert.equal(docker.remote, 'docker');
  let remote = 0;
  // Git stacks and the background jobs run on this server only (core limit): they name the local socket and the local /opt/stacks.
  const LOCAL_ONLY = /^(git-.*|ssh-version|compose-.*-git|stack-mark|container-redeploy|volume-backup.*|volume-check)$/;
  for (const c of m.capabilities.commands as { name: string; argv: string[]; args?: { pattern: string }[]; remote?: string }[]) {
    if (LOCAL_ONLY.test(c.name)) {
      assert.equal(c.remote, undefined, c.name);
      assert.ok(!c.argv.includes('{env}'), c.name);
      continue;
    }
    const envItems = c.argv.filter((a) => a === '{env}').length;
    assert.ok(!c.argv.some((a) => a.includes('{env}') && a !== '{env}'), `${c.name}: {env} is a whole item`);
    assert.ok(!c.argv.some((a) => a.startsWith('unix://')), `${c.name}: no hard-coded socket`);
    if (c.argv[0] === 'docker') {
      assert.equal(c.remote, 'docker', c.name);
      assert.equal(envItems, 1, c.name);
      remote++;
    } else {
      assert.equal(c.remote, undefined, c.name);
      assert.equal(envItems, 0, c.name);
    }
    if (c.argv.some((a) => a.startsWith('/opt/stacks/{1}{0}'))) {
      assert.equal(c.args?.length, 2, `${c.name}: name and prefix`);
      const re = new RegExp(`^(?:${c.args![1].pattern})$`);
      assert.ok(re.test('') && re.test('.envs/env-0a1b2c3d/'), c.name);
      assert.ok(!re.test('../x/') && !re.test('.envs/../'), c.name);
    }
    assert.ok(!c.argv.some((a) => a.startsWith('/opt/stacks/{0}')), `${c.name}: stack folders go through the prefix`);
  }
  assert.ok(remote >= 15);
});

test('the Environments, Activity and terminal strings exist in English and Italian', () => {
  const en = Object.keys(mergedEn.en).sort();
  const it = Object.keys(mergedEn.it).sort();
  assert.deepEqual(it, en);
  for (const k of ['envs.title', 'envs.state.limited', 'envs.addCard.title', 'activity.export', 'container.noTerminal.text']) assert.ok(en.includes(k), k);
});
