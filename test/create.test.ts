import test from 'node:test';
import assert from 'node:assert/strict';
import { createBody, emptySpec, gpuRequest, problems, resourceFields, resourceProblem, runText, specFromInspect, kv, rid } from '../src/views/create/model.ts';

const none = { names: new Set<string>(), used: new Map<string, string>(), recreate: false };

test('GPU request bodies: all, count, device ids', () => {
  const s = emptySpec();
  assert.equal(gpuRequest(s), undefined);
  s.gpu = 'all';
  assert.deepEqual(gpuRequest(s), { Driver: 'nvidia', Capabilities: [['gpu']], Options: {}, Count: -1 });
  s.gpu = 'count';
  s.gpuCount = '2';
  assert.equal(gpuRequest(s)?.Count, 2);
  s.gpu = 'ids';
  s.gpuIds = '0, GPU-abc  1';
  assert.deepEqual(gpuRequest(s), { Driver: 'nvidia', Capabilities: [['gpu']], Options: {}, DeviceIDs: ['0', 'GPU-abc', '1'] });
  s.image = 'alpine';
  assert.deepEqual(createBody(s).HostConfig.DeviceRequests, [gpuRequest(s)]);
  assert.match(runText(s), /--gpus '"device=0,GPU-abc,1"'/);
  s.gpu = 'all';
  assert.match(runText(s), /--gpus all/);
});

test('resources, devices, capabilities, sysctls and ulimits go into HostConfig', () => {
  const s = emptySpec();
  s.image = 'alpine';
  s.memoryMb = '128';
  s.memoryReservationMb = '64';
  s.memorySwapMb = '512';
  s.cpus = '1.5';
  s.cpuShares = '512';
  s.cpuset = '0-1';
  s.pidsLimit = '100';
  s.shmMb = '256';
  s.ulimits = [{ id: rid(), name: 'nofile', soft: '1024', hard: '4096' }];
  s.devices = [{ id: rid(), host: '/dev/ttyUSB0', container: '', perms: 'rw' }];
  s.capAdd = ['NET_ADMIN'];
  s.capDrop = ['ALL'];
  s.sysctls = [kv('net.ipv4.ip_forward', '1')];
  s.init = true;
  s.tty = true;
  s.openStdin = true;
  const body = createBody(s);
  const hc = body.HostConfig;
  assert.equal(hc.Memory, 128 * 1048576);
  assert.equal(hc.MemoryReservation, 64 * 1048576);
  assert.equal(hc.MemorySwap, 512 * 1048576);
  assert.equal(hc.NanoCpus, 1.5e9);
  assert.equal(hc.CpuShares, 512);
  assert.equal(hc.CpusetCpus, '0-1');
  assert.equal(hc.PidsLimit, 100);
  assert.equal(hc.ShmSize, 256 * 1048576);
  assert.deepEqual(hc.Ulimits, [{ Name: 'nofile', Soft: 1024, Hard: 4096 }]);
  assert.deepEqual(hc.Devices, [{ PathOnHost: '/dev/ttyUSB0', PathInContainer: '/dev/ttyUSB0', CgroupPermissions: 'rw' }]);
  assert.deepEqual(hc.CapAdd, ['NET_ADMIN']);
  assert.deepEqual(hc.CapDrop, ['ALL']);
  assert.deepEqual(hc.Sysctls, { 'net.ipv4.ip_forward': '1' });
  assert.equal(hc.Init, true);
  assert.equal(body.Tty, true);
  assert.equal(body.OpenStdin, true);
  assert.equal(hc.DeviceRequests, null);
  const text = runText(s);
  for (const part of ['--memory 128m', '--memory-reservation 64m', '--memory-swap 512m', '--cpu-shares 512', '--cpuset-cpus 0-1', '--pids-limit 100', '--shm-size 256m', '--ulimit nofile=1024:4096', '--device /dev/ttyUSB0:/dev/ttyUSB0:rw', '--cap-add NET_ADMIN', '--cap-drop ALL', '--sysctl net.ipv4.ip_forward=1', '--init', ' -i', ' -t']) assert.ok(text.includes(part), part);
});

const inspect = (hc: Record<string, any>, cfg: Record<string, any> = {}): any => ({
  Id: 'abcdef0123456789',
  Name: '/x',
  State: { Running: true, Restarting: false },
  HostConfig: { NetworkMode: 'default', RestartPolicy: { Name: 'no' }, ...hc },
  Config: { Image: 'alpine', Hostname: 'abcdef012345', Env: [], Labels: {}, Tty: false, ...cfg },
  Mounts: [],
  NetworkSettings: { Networks: { bridge: {} } },
});

test('recreate carries every resource field from inspect and back', () => {
  const hc = {
    Memory: 134217728, MemoryReservation: 67108864, MemorySwap: 536870912, NanoCpus: 500000000, CpuShares: 512, CpusetCpus: '0', PidsLimit: 100, ShmSize: 134217728,
    Ulimits: [{ Name: 'nofile', Soft: 2048, Hard: 4096 }],
    Devices: [{ PathOnHost: '/dev/zero', PathInContainer: '/dev/myzero', CgroupPermissions: 'rw' }],
    CapAdd: ['NET_ADMIN'], CapDrop: ['CAP_MKNOD'], Sysctls: { 'net.ipv4.ip_forward': '1' }, Init: true, Privileged: false,
    DeviceRequests: [{ Driver: 'nvidia', Count: -1, DeviceIDs: null, Capabilities: [['gpu']], Options: {} }, { Driver: 'cdi', DeviceIDs: ['x/y=z'], Capabilities: [] }],
  };
  const { spec, base } = specFromInspect(inspect(hc, { Tty: true, OpenStdin: true }), undefined);
  assert.equal(spec.memorySwapMb, '512');
  assert.equal(spec.gpu, 'all');
  assert.deepEqual(spec.capDrop, ['MKNOD']);
  assert.equal(spec.init && spec.tty && spec.openStdin, true);
  assert.equal(problems(spec, { ...none, recreate: true }).resources, undefined);
  const out = createBody(spec, base).HostConfig;
  for (const k of ['Memory', 'MemoryReservation', 'MemorySwap', 'NanoCpus', 'CpuShares', 'CpusetCpus', 'PidsLimit', 'ShmSize', 'Ulimits', 'Devices', 'CapAdd', 'Sysctls', 'Init']) assert.deepEqual(out[k], (hc as any)[k], k);
  assert.deepEqual(out.CapDrop, ['MKNOD']);
  // the non-GPU request is kept, the GPU one is rebuilt
  assert.deepEqual(out.DeviceRequests.map((r: any) => r.Driver).sort(), ['cdi', 'nvidia']);
  spec.gpu = 'off';
  assert.deepEqual(createBody(spec, base).HostConfig.DeviceRequests.map((r: any) => r.Driver), ['cdi']);
});

test('the default swap (twice the memory) and shm (64 MB) are not shown, so a new memory limit gets the new default', () => {
  const { spec, base } = specFromInspect(inspect({ Memory: 100 * 1048576, MemorySwap: 200 * 1048576, ShmSize: 67108864 }), undefined);
  assert.equal(spec.memorySwapMb, '');
  assert.equal(spec.shmMb, '');
  spec.memoryMb = '300';
  const hc = createBody(spec, base).HostConfig;
  assert.equal(hc.MemorySwap, 0);
  assert.equal(hc.ShmSize, 0);
  const o = specFromInspect(inspect({ Memory: 100 * 1048576, MemorySwap: 400 * 1048576 }), undefined);
  assert.equal(o.spec.memorySwapMb, '400', 'an explicit swap is shown and kept');
  assert.equal(createBody(o.spec, o.base).HostConfig.MemorySwap, 400 * 1048576);
  o.spec.memoryMb = '500';
  assert.equal(resourceProblem(o.spec), 'create.err.swap');
  assert.deepEqual(resourceFields(emptySpec()).Devices, []);
});

test('resource problems are reported with a message key', () => {
  const s = emptySpec();
  assert.equal(resourceProblem(s), undefined);
  const bad = (p: Partial<typeof s>) => resourceProblem({ ...s, ...p });
  assert.equal(bad({ cpuShares: '1' }), 'create.err.cpuShares');
  assert.equal(bad({ cpuset: 'a' }), 'create.err.cpuset');
  assert.equal(bad({ memoryMb: '100', memoryReservationMb: '200' }), 'create.err.reservation');
  assert.equal(bad({ memoryMb: '100', memorySwapMb: '50' }), 'create.err.swap');
  assert.equal(bad({ memorySwapMb: '500' }), 'create.err.swapNoMem');
  assert.equal(bad({ memorySwapMb: '-1' }), undefined);
  assert.equal(bad({ pidsLimit: '0' }), 'create.err.pids');
  assert.equal(bad({ ulimits: [{ id: 'a', name: 'nofile', soft: '9', hard: '5' }] }), 'create.err.ulimit');
  assert.equal(bad({ gpu: 'count', gpuCount: '0' }), 'create.err.gpuCount');
  assert.equal(bad({ gpu: 'ids', gpuIds: ' ' }), 'create.err.gpuIds');
  assert.equal(bad({ devices: [{ id: 'a', host: 'zero', container: '', perms: 'rwm' }] }), 'create.err.device');
  assert.equal(bad({ devices: [{ id: 'a', host: '/dev/zero', container: '', perms: 'x' }] }), 'create.err.device');
  assert.equal(bad({ capAdd: ['NET_ADMIN'], capDrop: ['NET_ADMIN'] }), 'create.err.capBoth');
  assert.equal(bad({ sysctls: [kv('foo', '1')] }), 'create.err.sysctl');
  assert.equal(bad({ sysctls: [kv('net.ipv4.ip_forward', '1')] }), undefined);
});
