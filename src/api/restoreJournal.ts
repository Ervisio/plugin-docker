/**
 * Containers stopped by a volume restore. A restore stops the running users of the volume, sends the backup and starts
 * them again, all from the page: if the browser closes in the middle, nobody starts them. So before the first stop the
 * page writes a small record in the plugin's config folder (a file in this user's ~/.config/ervisio/plugins/docker,
 * which survives the page), and removes it once the containers run again. The next visit to Volumes finds a record that
 * is still there and offers to start those containers.
 *
 * Why not one server-side command: the backup comes from the browser (it is sent to Docker as it is read), so the page
 * has to stay for the upload whatever runs the stop and the start. A job would also work only on this server and wait
 * for approval for users outside the docker group. The record works on every environment and for every user.
 */
import { loadFile, saveFile, type RestoreEntry } from '../settings';

export type { RestoreEntry };

/** Restores this page is running right now: not "interrupted". */
const active = new Set<string>();

const newId = (): string => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Entries of this environment that no running page owns. Pure. */
export function interruptedFor(entries: RestoreEntry[], env: string | undefined, running: ReadonlySet<string> = active): RestoreEntry[] {
  return entries.filter((e) => (e.env ?? undefined) === (env ?? undefined) && !running.has(e.id));
}

export interface ContainerState {
  Id: string;
  State?: string;
}

/**
 * What to do for an entry given the containers that exist now: start those that are there and not running; the ones
 * that are gone or already running need nothing.
 */
export function planRestart(entry: RestoreEntry, current: ContainerState[]): { start: { id: string; name: string }[]; gone: number; running: number } {
  const byId = new Map(current.map((c) => [c.Id, c]));
  const start: { id: string; name: string }[] = [];
  let gone = 0;
  let running = 0;
  for (const c of entry.containers) {
    const now = byId.get(c.id);
    if (!now) gone++;
    else if (now.State === 'running' || now.State === 'restarting') running++;
    else start.push(c);
  }
  return { start, gone, running };
}

async function update(fn: (list: RestoreEntry[]) => RestoreEntry[]): Promise<void> {
  const f = await loadFile('restore-journal');
  await saveFile('restore-journal', { ...f, pending: fn(f.pending ?? []) });
}

export async function readJournal(): Promise<RestoreEntry[]> {
  return (await loadFile('restore-journal')).pending ?? [];
}

/** Writes the record. Call it before the first container is stopped. Resolves with the id for endRestore(). */
export async function beginRestore(volume: string, containers: { id: string; name: string }[], env: string | undefined): Promise<string> {
  const entry: RestoreEntry = { id: newId(), ...(env ? { env } : {}), volume, containers, startedAt: Date.now() };
  active.add(entry.id);
  try {
    await update((l) => [...l, entry]);
  } catch (e) {
    active.delete(entry.id);
    throw e;
  }
  return entry.id;
}

/** The page is done with this restore (finished or failed): it is no longer "active". The record stays until forgotten. */
export function releaseRestore(id: string): void {
  active.delete(id);
}

/** Removes the record: the containers run again, or the user chose to leave them stopped. */
export async function forgetRestore(id: string): Promise<void> {
  active.delete(id);
  await update((l) => l.filter((e) => e.id !== id));
}
