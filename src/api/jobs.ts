/**
 * Background jobs the plugin declares (see scripts/gen-manifest.mjs) and the instances it creates from them. The daemon
 * runs them while no page is open. Needs Ervisio 0.5 (`sdk.api.jobs`); check `jobsAvailable()` first.
 *
 * Jobs here use only the docker-group path (no step needs root for a member of `docker`). A user who is not in that
 * group gets an instance that waits until an administrator approves it in Settings › Plugin jobs: the plugin cannot
 * approve it itself, so `confirmAdmin` is never sent.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { currentEnv } from './environments';
import { getSdk, type JobInstance, type JobRun, type JobSchedule } from '../sdk';

export type { JobInstance, JobRun, JobSchedule } from '../sdk';

/** The console has background jobs (Ervisio 0.5 or later). */
export const jobsAvailable = (): boolean => !!getSdk().api.jobs;
/**
 * Jobs run on the server that runs Ervisio, never on another Docker host (a core limit). So Git stacks, redeploy webhooks,
 * automatic updates and scheduled backups are offered only while this server is the open environment.
 */
export const jobsHere = (): boolean => jobsAvailable() && !currentEnv();
/** Jobs exist, but the open environment is another host: show the explanation instead of the controls. */
export const jobsElsewhere = (): boolean => jobsAvailable() && !!currentEnv();

/** Notification choice of a job: n none (core failure alerts still apply), s success, f failure, b both. */
export type NotifyMode = 'n' | 's' | 'f' | 'b';
export const NOTIFY_MODES: NotifyMode[] = ['n', 's', 'f', 'b'];

export const pollJob = (m: NotifyMode) => `git-poll-${m}`;
export const backupJob = (m: NotifyMode) => `volume-backup-${m}`;
export const POLL_JOBS = NOTIFY_MODES.map(pollJob);
export const BACKUP_JOBS = NOTIFY_MODES.map(backupJob);

export const modeOfJob = (job: string): NotifyMode => (job.slice(-1) as NotifyMode);

export type Approval = 'ok' | 'waiting' | 'off';
/** Whether an instance can run: waiting for an administrator, switched off, or fine. */
export function approvalOf(i: JobInstance): Approval {
  if (i.needsAdmin && (!i.approval || !i.approval.valid)) return 'waiting';
  if (!i.enabled) return 'off';
  return 'ok';
}

export async function listInstances(jobs?: string[]): Promise<JobInstance[]> {
  const api = getSdk().api.jobs;
  if (!api) return [];
  const all = await api.list();
  return jobs ? all.filter((i) => jobs.includes(i.job)) : all;
}

/** Instances of the given jobs whose param `key` equals `value`. */
export const forParam = (list: JobInstance[], jobs: string[], key: string, value: string): JobInstance[] =>
  list.filter((i) => jobs.includes(i.job) && i.params[key] === value);

export function jobsApi() {
  const api = getSdk().api.jobs;
  if (!api) throw new Error('This Ervisio is too old for background jobs (needs 0.5).');
  return api;
}

/** Hook: the instances of some jobs, with reload(). Polls every 20 s while visible so "last run" stays fresh. */
export function useInstances(jobs?: string[]): { list: JobInstance[]; loading: boolean; error: string; reload(): Promise<void> } {
  const [list, setList] = useState<JobInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const key = (jobs ?? []).join(',');
  const reload = useCallback(async () => {
    try {
      const l = await listInstances(jobs);
      if (alive.current) {
        setList(l);
        setError('');
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    alive.current = true;
    void reload();
    const t = setInterval(() => { if (!document.hidden) void reload(); }, 20000);
    return () => { alive.current = false; clearInterval(t); };
  }, [reload]);
  return { list, loading, error, reload };
}

export function scheduleText(s: JobInstance['schedule']): { kind: 'every'; seconds: number } | { kind: 'at'; at: string[]; days?: number[] } | null {
  if (!s) return null;
  if (s.every) return { kind: 'every', seconds: s.every };
  if (s.at?.length) return { kind: 'at', at: s.at, days: s.days };
  return null;
}

/** Last run status of an instance with the failure that was handled by a notify step counted as failed. */
export function runFailed(r: JobRun): boolean {
  return r.status === 'failed' || r.status === 'timeout' || r.steps.some((s) => s.status === 'failed');
}

export const hookUrl = (path: string): string => `${location.origin}${path}`;

export const toSchedule = (s: JobSchedule): JobSchedule => s;

/** Deletes every instance of these jobs that belongs to a stack (or any other param). Errors are ignored: it is clean-up. */
export async function removeInstances(jobs: string[], key: string, value: string): Promise<number> {
  const api = getSdk().api.jobs;
  // Jobs belong to this server's stacks: a stack of the same name on another host has none.
  if (!api || currentEnv()) return 0;
  let n = 0;
  try {
    for (const i of await listInstances(jobs)) {
      if (i.params[key] !== value) continue;
      await api.delete(i.id).then(() => n++, () => undefined);
    }
  } catch { /* no jobs */ }
  return n;
}
