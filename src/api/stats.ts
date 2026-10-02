/** Stats math and the shared per-container stats streams. */
import { docker, type StreamHandle } from './engine';
import { currentCaps, onEnvChange } from './environments';
import { JsonLines } from './streams';
import type { StatPoint, StatsRaw } from './types';

/** CPU percent of one core between two raw samples (like `docker stats`). Null when it cannot be computed. */
export function cpuPercent(prev: StatsRaw | undefined, cur: StatsRaw): number | null {
  const p = prev?.cpu_stats ?? cur.precpu_stats;
  if (!p || !p.cpu_usage?.total_usage) return null;
  const cpuDelta = cur.cpu_stats.cpu_usage.total_usage - p.cpu_usage.total_usage;
  const sysDelta = (cur.cpu_stats.system_cpu_usage ?? 0) - (p.system_cpu_usage ?? 0);
  if (sysDelta <= 0 || cpuDelta < 0) return null;
  const cpus = cur.cpu_stats.online_cpus || cur.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  return (cpuDelta / sysDelta) * cpus * 100;
}

/** Memory in use without page cache, the number `docker stats` shows. */
export function memoryUsed(m: StatsRaw['memory_stats']): number {
  const usage = m.usage ?? 0;
  const cache = m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? m.stats?.cache ?? 0;
  return Math.max(0, usage - cache);
}

export function toPoint(prev: { raw: StatsRaw; point: StatPoint } | undefined, raw: StatsRaw): StatPoint {
  const cpu = cpuPercent(prev?.raw, raw);
  const memUsed = memoryUsed(raw.memory_stats);
  const memLimit = raw.memory_stats.limit ?? 0;
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(raw.networks ?? {})) {
    rx += n.rx_bytes;
    tx += n.tx_bytes;
  }
  let br = 0;
  let bw = 0;
  for (const e of raw.blkio_stats?.io_service_bytes_recursive ?? []) {
    if (e.op.toLowerCase() === 'read') br += e.value;
    else if (e.op.toLowerCase() === 'write') bw += e.value;
  }
  const t = Date.parse(raw.read) || Date.now();
  const dt = prev ? (t - prev.point.t) / 1000 : 0;
  return {
    t,
    cpu: cpu ?? prev?.point.cpu ?? 0,
    memUsed,
    memLimit,
    memPct: memLimit > 0 ? (memUsed / memLimit) * 100 : 0,
    netRx: rx,
    netTx: tx,
    netRxRate: prev && dt > 0 ? Math.max(0, (rx - prev.point.netRx) / dt) : 0,
    netTxRate: prev && dt > 0 ? Math.max(0, (tx - prev.point.netTx) / dt) : 0,
    blkRead: br,
    blkWrite: bw,
    pids: raw.pids_stats?.current ?? 0,
  };
}

/* ---------- shared streams ---------- */

const HISTORY = 180;
const MAX_STREAMS = 24;

interface Entry {
  id: string;
  listeners: Set<() => void>;
  handle?: StreamHandle;
  last?: StatPoint;
  prev?: { raw: StatsRaw; point: StatPoint };
  history: StatPoint[];
  retry?: ReturnType<typeof setTimeout>;
  failures: number;
}

const entries = new Map<string, Entry>();
let open = 0;

const POLL_MS = 5000;

function connect(e: Entry): void {
  if (e.handle || open >= MAX_STREAMS) return;
  open++;
  const lines = new JsonLines<StatsRaw>((raw) => {
    const first = !e.prev;
    const point = toPoint(e.prev, raw);
    e.prev = { raw, point };
    // The first frame has no earlier sample to take a CPU delta from: keep it as the baseline only.
    if (first) return;
    e.last = point;
    e.failures = 0;
    e.history.push(point);
    if (e.history.length > HISTORY) e.history.shift();
    e.listeners.forEach((l) => l());
  });
  const done = () => {
    if (!e.handle) return;
    e.handle = undefined;
    open--;
    e.prev = undefined;
    if (e.listeners.size && ++e.failures <= 5) e.retry = setTimeout(() => connect(e), 3000 * e.failures);
  };
  if (!currentCaps().live) {
    // Streams are held back (Portainer agent): one sample at a time instead, five seconds apart.
    let alive = true;
    const poll = () => {
      if (!alive) return;
      docker.get<StatsRaw>(`/containers/${e.id}/stats`, { stream: 'false' }).then(
        (raw) => {
          if (!alive) return;
          lines.push(new TextEncoder().encode(JSON.stringify(raw) + '\n'));
          e.retry = setTimeout(poll, POLL_MS);
        },
        () => { if (alive) e.retry = setTimeout(poll, POLL_MS * 2); },
      );
    };
    poll();
    e.handle = { close: () => { alive = false; clearTimeout(e.retry); } };
    return;
  }
  e.handle = docker.stream('GET', `/containers/${e.id}/stats`, { query: { stream: 'true' } }, {
    onData: (c) => lines.push(c),
    onEnd: done,
    onError: done,
  });
}

/** Subscribes to a container's stats stream; the stream opens with the first subscriber and closes with the last. */
export function subscribeStats(id: string, listener: () => void): () => void {
  let e = entries.get(id);
  if (!e) {
    e = { id, listeners: new Set(), history: [], failures: 0 };
    entries.set(id, e);
  }
  e.listeners.add(listener);
  if (e.listeners.size === 1) {
    e.failures = 0;
    connect(e);
  }
  const entry = e;
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size) {
      clearTimeout(entry.retry);
      if (entry.handle) {
        entry.handle.close();
        entry.handle = undefined;
        open--;
      }
      if (entries.get(id) === entry) entries.delete(id);
    }
  };
}

export const statsHistory = (id: string): StatPoint[] => entries.get(id)?.history ?? [];
export const statsLast = (id: string): StatPoint | undefined => entries.get(id)?.last;

// Switching environment: the streams belong to the old host. Views resubscribe when they render again.
onEnvChange(() => {
  for (const e of entries.values()) {
    clearTimeout(e.retry);
    e.handle?.close();
    e.handle = undefined;
    e.listeners.clear();
  }
  entries.clear();
  open = 0;
});
