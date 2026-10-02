/** The activity log of this plugin (sdk.audit.list): filters, the environment column and the CSV export. */
import type { AuditEntry } from '../sdk';

/** Actions a plugin entry can have; the filter offers these. */
export const ACTIONS = ['command', 'pty', 'http', 'upload', 'download', 'file.write', 'file.mkdir', 'file.remove', 'job.run', 'job.webhook', 'job.approve'] as const;

export interface ActivityFilter {
  /** '' = all, 'local' = this server, else an environment id. */
  env: string;
  user: string;
  action: string;
  /** YYYY-MM-DD, local time. */
  from: string;
  to: string;
}

export const EMPTY_FILTER: ActivityFilter = { env: '', user: '', action: '', from: '', to: '' };

/** Start of a local day in ms (from), or the start of the day after (to, so the day itself is included). */
export function dayMs(day: string, end: boolean): number | undefined {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(day);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (end ? 1 : 0));
  return d.getTime();
}

/** The part of the filter the daemon applies. The environment has no server-side filter: see matchesEnv. */
export function serverQuery(f: ActivityFilter): { user?: string; action?: string; since?: number; until?: number } {
  return {
    ...(f.user.trim() ? { user: f.user.trim() } : {}),
    ...(f.action ? { action: f.action } : {}),
    ...(dayMs(f.from, false) !== undefined ? { since: dayMs(f.from, false) } : {}),
    ...(dayMs(f.to, true) !== undefined ? { until: dayMs(f.to, true) } : {}),
  };
}

export const matchesEnv = (e: AuditEntry, env: string): boolean => (env === '' ? true : env === 'local' ? !e.env : e.env === env);

/** The environment of an entry as a name: this server when none, the id itself when the environment was removed since. */
export const envLabel = (e: AuditEntry, names: Map<string, string>, local: string): string => (e.env ? names.get(e.env) ?? e.env : local);

const csvCell = (v: string | number | undefined): string => {
  let s = v === undefined ? '' : String(v);
  // A spreadsheet runs cells that start with these.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(entries: AuditEntry[], names: Map<string, string>, local: string): string {
  const head = ['time', 'user', 'action', 'target', 'environment', 'result', 'code', 'detail', 'origin'];
  const rows = entries.map((e) => [e.time, e.user, e.action, e.target, envLabel(e, names, local), e.result, e.code, e.detail, e.origin].map(csvCell).join(','));
  return [head.join(','), ...rows].join('\n') + '\n';
}
