/**
 * What the Environments page shows for one host: container counts, stacks, CPU and memory in use. Kept cheap: two list
 * calls and one stats sample for each of at most SAMPLE running containers (four at a time), once every 30 seconds
 * while the page is visible. CPU and memory are the sum over the sampled containers against the host's totals.
 */
import { jsonIn, requestIn } from './engine';
import { cpuPercent, memoryUsed } from './stats';
import { COMPOSE_PROJECT, type Container, type StatsRaw, type SystemInfo } from './types';

export const SAMPLE = 24;
export const REFRESH_MS = 30000;

export interface EnvSummary {
  /** Host name the engine reports. */
  host: string;
  engine: string;
  running: number;
  stopped: number;
  stacks: number;
  /** Percent of the host's CPU and memory used by the sampled containers; null when nothing could be sampled. */
  cpu: number | null;
  mem: number | null;
  /** More running containers than were sampled: the bars are a lower bound. */
  partial: boolean;
  at: number;
}

export function summarize(info: SystemInfo, list: Container[], samples: StatsRaw[], at = Date.now()): EnvSummary {
  const running = list.filter((c) => c.State === 'running' || c.State === 'restarting' || c.State === 'paused').length;
  const stacks = new Set(list.map((c) => c.Labels?.[COMPOSE_PROJECT]).filter(Boolean)).size;
  let cpu: number | null = null;
  let mem: number | null = null;
  if (samples.length) {
    const cores = info.NCPU || 1;
    const sum = samples.reduce((a, s) => a + (cpuPercent(undefined, s) ?? 0), 0);
    cpu = Math.min(100, sum / cores);
    mem = info.MemTotal ? Math.min(100, (samples.reduce((a, s) => a + memoryUsed(s.memory_stats), 0) / info.MemTotal) * 100) : null;
  } else if (running === 0) {
    cpu = 0;
    mem = 0;
  }
  return {
    host: info.Name,
    engine: info.ServerVersion,
    running,
    stopped: list.length - running,
    stacks,
    cpu,
    mem,
    partial: running > samples.length && samples.length > 0,
    at,
  };
}

/** Ask one environment (undefined = this server). Rejects when the host does not answer. */
export async function loadSummary(env: string | undefined, onPartial?: (s: EnvSummary) => void): Promise<EnvSummary> {
  const [info, list] = await Promise.all([jsonIn<SystemInfo>(env, '/info'), jsonIn<Container[]>(env, '/containers/json', { all: '1' })]);
  // Counts are known now; the bars wait for the stats samples (about a second each).
  onPartial?.({ ...summarize(info, list, []), cpu: null, mem: null });
  const work = list.filter((c) => c.State === 'running').slice(0, SAMPLE);
  const samples: StatsRaw[] = [];
  let i = 0;
  const worker = async () => {
    while (i < work.length) {
      const c = work[i++];
      try {
        const r = await requestIn(env, 'GET', `/containers/${c.Id}/stats`, { query: { stream: 'false' } });
        if (r.status < 400) samples.push(r.json() as StatsRaw);
      } catch {
        /* a container that stops while sampled is simply left out */
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return summarize(info, list, samples);
}
