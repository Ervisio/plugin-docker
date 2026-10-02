/**
 * Volume files, backup and restore. The Engine API cannot read a volume directly, so a short-lived helper container
 * mounts it and the archive API does the work on the helper, exactly as for container files:
 *
 *   browse   helper with the volume read-only at /volume; the file browser lists it (exec ls) and downloads from it
 *   backup   helper read-only; GET /containers/{helper}/archive?path=/volume streamed to disk by api.download
 *   restore  helper read-write; PUT /containers/{helper}/archive (a tar, any size) streamed by api.upload
 *
 * The helper is a pinned busybox (HELPER_IMAGE) with no network, labelled io.ervisio.helper=volume, created with
 * AutoRemove and a `sleep` that bounds its lifetime, so Docker removes it even when this page is gone. The page also
 * removes it as soon as it is done (browse closed, restore finished) and sweeps leftovers (sweepHelpers).
 *
 * STEP SEQUENCE a scheduled backup job can repeat over the same HTTP calls (nothing here depends on the page):
 *   1. GET    /images/json                            find HELPER_IMAGE (or any busybox:*); POST /images/create?fromImage=busybox&tag=1.37 if missing
 *   2. POST   /containers/create?name=ervisio-vol-<id>  body helperSpec(volume, 'ro', lifetime, 'backup')
 *   3. POST   /containers/{id}/start
 *   4. GET    /containers/{id}/archive?path=/volume   the tar stream, saved as <volume>-<YYYYMMDD>.tar (backupName)
 *   5. DELETE /containers/{id}?force=1                the job knows when the stream ended, so it removes the helper at once
 * Restore: steps 1-3 with 'rw'; optionally exec `find /volume -mindepth 1 -maxdepth 1 -exec rm -rf {} +`
 * (POST /containers/{id}/exec, POST /exec/{execId}/start); PUT /containers/{id}/archive?path=<restoreRoot(tar)>
 * with the tar as body; DELETE the helper. Stop and start the containers that use the volume around it if wanted.
 */
import { docker, DockerError, engineMessage } from './engine';
import { listTar } from './origin';
import { execRun, FsError, type Transfer } from './files';
import type { Container } from './types';

export const HELPER_IMAGE = 'busybox:1.37';
export const HELPER_LABEL = 'io.ervisio.helper';
export const HELPER_VOLUME_LABEL = 'io.ervisio.helper.volume';
export const HELPER_EXPIRES_LABEL = 'io.ervisio.helper.expires';
export const HELPER_PURPOSE_LABEL = 'io.ervisio.helper.purpose';
export const VOLUME_ROOT = '/volume';

export type HelperMode = 'ro' | 'rw';
export type HelperPurpose = 'browse' | 'backup' | 'restore';

const enc = encodeURIComponent;
const day = (d = new Date()): string => d.toISOString().slice(0, 10).replace(/-/g, '');

/** "<volume>-<YYYYMMDD>.tar". */
export const backupName = (volume: string, d = new Date()): string => `${volume.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${day(d)}.tar`;

/** Helper containers are not user containers: lists leave them out. */
export const isHelper = (c: { Labels?: Record<string, string> | null }): boolean => !!c.Labels?.[HELPER_LABEL];

/**
 * How long a helper may live, in seconds. A backup streams to the browser after api.download has returned, so the page
 * cannot tell when it ends: the helper stays long enough for `size` bytes at 1 MiB/s plus 5 minutes (at most a day).
 */
export function lifetimeFor(purpose: HelperPurpose, size: number): number {
  if (purpose === 'backup') return Math.min(86400, 300 + Math.ceil((size > 0 ? size : 20 * 1024 ** 3) / (1024 * 1024)));
  if (purpose === 'browse') return 1800;
  return 7200;
}

/** The JSON body of POST /containers/create for a helper. */
export function helperSpec(image: string, volume: string, mode: HelperMode, purpose: HelperPurpose, lifetime: number, now = Date.now()) {
  return {
    Image: image,
    Cmd: ['sleep', String(lifetime)],
    NetworkDisabled: true,
    StopTimeout: 1,
    Labels: {
      [HELPER_LABEL]: 'volume',
      [HELPER_VOLUME_LABEL]: volume,
      [HELPER_PURPOSE_LABEL]: purpose,
      [HELPER_EXPIRES_LABEL]: String(Math.floor(now / 1000) + lifetime),
    },
    HostConfig: {
      AutoRemove: true,
      NetworkMode: 'none',
      SecurityOpt: ['no-new-privileges'],
      Mounts: [{ Type: 'volume', Source: volume, Target: VOLUME_ROOT, ReadOnly: mode === 'ro', VolumeOptions: { NoCopy: true } }],
    },
  };
}

/* ---------- the image ---------- */

/** A busybox image that is here already: HELPER_IMAGE first, then any other busybox tag. */
export async function findHelperImage(): Promise<string | undefined> {
  const list = await docker.get<{ RepoTags?: string[] | null }[]>('/images/json');
  const tags = list.flatMap((i) => i.RepoTags ?? []);
  if (tags.includes(HELPER_IMAGE)) return HELPER_IMAGE;
  return tags.filter((x) => /^busybox:[0-9a-z._-]+$/.test(x)).sort()[0];
}

/* ---------- the helper ---------- */

export interface Helper {
  id: string;
  volume: string;
  mode: HelperMode;
  /** Removes the helper (and is safe to call again). */
  remove(): Promise<void>;
}

/** Deletes a container by id, whether it runs or not. A helper that Docker is already removing is not an error. */
export async function removeContainer(id: string): Promise<void> {
  try {
    await docker.delete(`/containers/${enc(id)}`, { force: '1', v: '1' });
  } catch (e) {
    if (e instanceof DockerError && (e.status === 404 || e.status === 409)) return;
    throw e;
  }
}

/** Creates and starts a helper for the volume. The caller must remove it (or let `lifetime` end). */
export async function createHelper(image: string, volume: string, mode: HelperMode, purpose: HelperPurpose, size = -1): Promise<Helper> {
  const name = `ervisio-vol-${purpose}-${Math.random().toString(36).slice(2, 10)}`;
  const made = await docker.post<{ Id: string }>('/containers/create', { name }, helperSpec(image, volume, mode, purpose, lifetimeFor(purpose, size)));
  const id = made.Id;
  try {
    await docker.post(`/containers/${enc(id)}/start`);
  } catch (e) {
    await removeContainer(id).catch(() => undefined);
    throw e;
  }
  let gone = false;
  return {
    id,
    volume,
    mode,
    async remove() {
      if (gone) return;
      gone = true;
      await removeContainer(id);
    },
  };
}

/** Removes every helper of a volume (before the volume is deleted, which a helper would block). */
export async function removeHelpersOf(volume: string): Promise<number> {
  const list = await listHelpers();
  const mine = list.filter((c) => c.Labels?.[HELPER_VOLUME_LABEL] === volume);
  await Promise.all(mine.map((c) => removeContainer(c.Id).catch(() => undefined)));
  return mine.length;
}

export async function listHelpers(): Promise<Container[]> {
  return docker.get<Container[]>('/containers/json', { all: '1', filters: JSON.stringify({ label: [`${HELPER_LABEL}=volume`] }) });
}

/**
 * Removes helpers nobody needs any more: past their expiry, not running (never started, exited, dead), or a browse
 * helper that is not in `keep` and is older than five minutes (its page was closed). Returns how many were removed.
 */
export async function sweepHelpers(keep: Set<string> = new Set(), now = Date.now()): Promise<number> {
  let n = 0;
  for (const c of await listHelpers()) {
    if (keep.has(c.Id)) continue;
    const expires = Number(c.Labels?.[HELPER_EXPIRES_LABEL] ?? 0) * 1000;
    const age = now - c.Created * 1000;
    const orphan =
      (expires > 0 && expires < now) ||
      (c.State !== 'running' && age > 60_000) ||
      (c.Labels?.[HELPER_PURPOSE_LABEL] === 'browse' && age > 300_000);
    if (!orphan) continue;
    await removeContainer(c.Id).then(() => n++, () => undefined);
  }
  return n;
}

/* ---------- restore ---------- */

/** Removes everything inside the volume (the helper must be read-write). */
export async function emptyVolume(helper: Helper): Promise<void> {
  const r = await execRun(helper.id, ['find', VOLUME_ROOT, '-mindepth', '1', '-maxdepth', '1', '-exec', 'rm', '-rf', '{}', '+']);
  if (r.code !== 0) throw new FsError('other', r.stderr.trim() || `find exited with ${r.code}`);
}

/**
 * Where a backup tar must be sent: a tar made by backup has a top folder "volume/", so it goes to "/" and lands in
 * /volume; any other tar (files at its top level) goes to /volume itself. Reads only the start of the file, and
 * understands gzip. Returns undefined when the file does not look like a tar.
 */
export async function restoreRoot(file: Blob): Promise<'/' | typeof VOLUME_ROOT | undefined> {
  let head: Uint8Array = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) head = await gunzipStart(file);
  if (head.length < 512) return undefined;
  let first: string | undefined;
  try {
    first = listTar(head)[0]?.name;
  } catch {
    return undefined;
  }
  if (first === undefined) return undefined;
  const top = first.replace(/^\.\//, '').split('/')[0];
  return top === 'volume' ? '/' : VOLUME_ROOT;
}

/** The first bytes of a gzip file, uncompressed (a cut stream is fine: what came out before the error is kept). */
async function gunzipStart(file: Blob): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') return new Uint8Array(0);
  const reader = file.slice(0, 256 * 1024).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < 64 * 1024) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
    }
  } catch {
    /* the slice ends mid-stream */
  }
  void reader.cancel().catch(() => undefined);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Sends the tar of a restore into the helper (read-write). `root` comes from restoreRoot. */
export function sendRestore(helper: Helper, root: string, file: Blob, onProgress?: (p: { loaded: number; total: number }) => void): Transfer {
  const up = docker.upload('PUT', `/containers/${enc(helper.id)}/archive`, { query: { path: root }, headers: { 'Content-Type': 'application/x-tar' } }, file, onProgress);
  return {
    cancel: () => up.cancel(),
    done: up.then((r) => {
      if (r.status >= 400) throw new DockerError(r.status, engineMessage(r));
    }),
  };
}

/** Starts the backup download from a read-only helper. Resolves when the browser starts saving. */
export function startBackup(helper: Helper, volume: string) {
  return docker.download(`/containers/${enc(helper.id)}/archive`, { path: VOLUME_ROOT }, backupName(volume));
}
