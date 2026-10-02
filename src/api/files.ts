/**
 * Files inside a container, through the Engine API only (no shell needed on the host):
 *   list      exec `ls -la --full-time` when the container runs and has ls; otherwise GET /archive of the folder
 *             and read the tar headers (works on stopped containers and on images without a shell)
 *   download  GET /archive: a file up to SAVE_LIMIT is unpacked here and saved with saveFile; anything else
 *             (folders, bigger files) is streamed to disk as the tar by api.download, with no size limit
 *   upload    PUT /archive with a tar Blob built around the picked File (never read into memory) by api.upload
 *   mkdir     PUT /archive with a folder entry
 *   remove    exec `rm -rf` (needs a running container with rm)
 * Only listing a folder of a stopped container (no ls) reads a whole answer into memory, capped by maxBody.
 */
import { listTar, parseTar } from './origin';
import { tarBlob } from './tar';
import { docker, DockerError, engineMessage } from './engine';
import { getSdk, type DownloadOptions } from '../sdk';

/** Most entries shown for one folder. */
export const LIST_LIMIT = 5000;

export type FsKind = 'dir' | 'file' | 'link' | 'other';
export interface FsEntry {
  name: string;
  kind: FsKind;
  size: number;
  /** "rwxr-xr-x" */
  mode: string;
  /** Milliseconds since the epoch, 0 when unknown. */
  mtime: number;
  owner?: string;
  group?: string;
  target?: string;
}
export interface Listing {
  path: string;
  entries: FsEntry[];
  via: 'exec' | 'archive';
  /** More entries than LIST_LIMIT: the list was cut. */
  cut?: boolean;
}

export type FsErrorCode = 'noexec' | 'notfound' | 'notdir' | 'denied' | 'toolarge' | 'readonly' | 'other';
export class FsError extends Error {
  code: FsErrorCode;
  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.name = 'FsError';
    this.code = code;
  }
}

const enc = encodeURIComponent;
const td = new TextDecoder();

/* ---------- paths ---------- */

export const joinPath = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`);
export function parentOf(path: string): string {
  const p = path.replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
/** Collapses //, ./ and ../ of an absolute path. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}
export const validName = (n: string): boolean => !!n && n !== '.' && n !== '..' && !/[/\0\n]/.test(n) && new TextEncoder().encode(n).length <= 255;

export function modeString(mode: number): string {
  const bits = 'rwxrwxrwx';
  let s = '';
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? bits[i] : '-';
  const chars = s.split('');
  if (mode & 0o4000) chars[2] = chars[2] === 'x' ? 's' : 'S';
  if (mode & 0o2000) chars[5] = chars[5] === 'x' ? 's' : 'S';
  if (mode & 0o1000) chars[8] = chars[8] === 'x' ? 't' : 'T';
  return chars.join('');
}

/* ---------- exec ---------- */

/** Splits Docker's multiplexed stream (8-byte frames) into stdout and stderr text. */
export function demux(bytes: Uint8Array): { stdout: string; stderr: string } {
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const kind = bytes[pos];
    const size = ((bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7]) >>> 0;
    const body = bytes.subarray(pos + 8, pos + 8 + size);
    if (kind === 2) err.push(body);
    else out.push(body);
    pos += 8 + size;
  }
  const join = (parts: Uint8Array[]) => td.decode(Uint8Array.from(parts.flatMap((p) => Array.from(p))));
  return { stdout: join(out), stderr: join(err) };
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command in a running container without a tty. Throws FsError('noexec') when the program does not exist. */
export async function execRun(id: string, cmd: string[]): Promise<ExecResult> {
  const created = await docker.post<{ Id: string }>(`/containers/${enc(id)}/exec`, undefined, { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd });
  const r = await docker.request('POST', `/exec/${created.Id}/start`, { body: { Detach: false, Tty: false } });
  // The Portainer agent drops upgraded connections and the core answers 501: same as a container without a shell.
  if (r.status === 501) throw new FsError('noexec', 'This environment cannot run commands in containers');
  if (r.status >= 400) {
    let msg = r.body;
    try {
      msg = (r.json() as { message?: string }).message ?? msg;
    } catch {
      /* plain text */
    }
    throw new FsError(/executable file not found|no such file or directory|not found in \$PATH/i.test(msg) ? 'noexec' : 'other', msg.slice(0, 300));
  }
  const { stdout, stderr } = demux(r.bytes());
  let code = 0;
  for (let i = 0; i < 20; i++) {
    const st = await docker.get<{ Running: boolean; ExitCode: number }>(`/exec/${created.Id}/json`);
    if (!st.Running) {
      code = st.ExitCode;
      break;
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  if (code === 126 || code === 127) throw new FsError('noexec', stderr || stdout);
  return { code, stdout, stderr };
}

/* ---------- list ---------- */

const LS_LINE = /^([-dlcbpsD])([rwxsStT-]{9})[.+@]?\s+\d+\s+(\S+)\s+(\S+)\s+(?:\d+,\s*)?(\d+)\s+(\d{4}-\d\d-\d\d)\s+(\d\d:\d\d:\d\d)(?:\.\d+)?\s+([+-]\d{4})\s+(.*)$/;

/** Parses the output of `ls -la --full-time` (GNU and busybox). Lines that do not look like entries are skipped. */
export function parseLs(text: string): FsEntry[] {
  const out: FsEntry[] = [];
  for (const line of text.split('\n')) {
    const m = LS_LINE.exec(line);
    if (!m) continue;
    const [, t, perms, owner, group, size, date, time, tz, rest] = m;
    let name = rest;
    let target: string | undefined;
    if (t === 'l') {
      const i = rest.indexOf(' -> ');
      if (i >= 0) {
        name = rest.slice(0, i);
        target = rest.slice(i + 4);
      }
    }
    if (name === '.' || name === '..') continue;
    const kind: FsKind = t === 'd' ? 'dir' : t === '-' ? 'file' : t === 'l' ? 'link' : 'other';
    const mtime = Date.parse(`${date}T${time}${tz.slice(0, 3)}:${tz.slice(3)}`);
    out.push({ name, kind, size: +size, mode: perms, mtime: Number.isNaN(mtime) ? 0 : mtime, owner, group, target });
  }
  return out;
}

export function sortEntries(list: FsEntry[]): FsEntry[] {
  const rank = (e: FsEntry) => (e.kind === 'dir' ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Reads a folder from the tar of GET /archive: the entries one level below it. */
export function entriesFromTar(bytes: Uint8Array): FsEntry[] {
  const out = new Map<string, FsEntry>();
  for (const e of listTar(bytes)) {
    const rel = e.name.replace(/^\.\//, '').replace(/^\.$/, '').replace(/\/+$/, '');
    if (!rel || rel.includes('/')) continue;
    const kind: FsKind = e.type === '5' ? 'dir' : e.type === '0' || e.type === '7' ? 'file' : e.type === '2' ? 'link' : 'other';
    out.set(rel, { name: rel, kind, size: e.size, mode: modeString(e.mode), mtime: e.mtime * 1000, target: e.type === '2' ? e.linkname : undefined });
  }
  return [...out.values()];
}

function archiveError(e: unknown, what: string): FsError {
  if (e instanceof FsError) return e;
  if (e instanceof DockerError) {
    if (e.status === 404) return new FsError('notfound', e.message);
    if (e.status === 403) return new FsError(/read-only/i.test(e.message) ? 'readonly' : 'denied', e.message);
    return new FsError('other', e.message);
  }
  const msg = (e as Error)?.message ?? String(e);
  if (/too large|exceed|larger than|limit|maxBody|too big/i.test(msg)) return new FsError('toolarge', msg);
  return new FsError('other', `${what}: ${msg}`);
}

async function archiveGet(id: string, path: string): Promise<Uint8Array> {
  try {
    const r = await docker.request('GET', `/containers/${enc(id)}/archive`, { query: { path } });
    if (r.status >= 400) {
      let msg = r.body;
      try {
        msg = (r.json() as { message?: string }).message ?? msg;
      } catch {
        /* plain */
      }
      throw new DockerError(r.status, msg.slice(0, 300));
    }
    return r.bytes();
  } catch (e) {
    throw archiveError(e, 'Docker could not read the folder');
  }
}

/** List a folder. `canExec` is true when the container runs; with ls missing the archive API is used instead. */
export async function listDir(id: string, path: string, canExec: boolean): Promise<Listing> {
  const dir = normalizePath(path);
  if (canExec) {
    try {
      const r = await execRun(id, ['ls', '-la', '--full-time', '--', dir === '/' ? '/' : `${dir}/`]);
      if (r.code === 0) {
        const all = sortEntries(parseLs(r.stdout));
        return { path: dir, entries: all.slice(0, LIST_LIMIT), via: 'exec', cut: all.length > LIST_LIMIT };
      }
      if (/No such file/i.test(r.stderr)) throw new FsError('notfound', r.stderr.trim());
      if (/Not a directory/i.test(r.stderr)) throw new FsError('notdir', r.stderr.trim());
      if (/Permission denied/i.test(r.stderr)) throw new FsError('denied', r.stderr.trim());
      // ls exists but dislikes an option: read the folder the other way.
    } catch (e) {
      if (!(e instanceof FsError) || e.code === 'notfound' || e.code === 'notdir' || e.code === 'denied') throw e;
    }
  }
  const bytes = await archiveGet(id, dir === '/' ? '/.' : `${dir}/.`);
  const all = sortEntries(entriesFromTar(bytes));
  return { path: dir, entries: all.slice(0, LIST_LIMIT), via: 'archive', cut: all.length > LIST_LIMIT };
}

/* ---------- download, upload, folders, delete ---------- */

/** Files up to this size are read in the browser, taken out of their tar and saved with their own name. */
export const SAVE_LIMIT = 64 * 1024 * 1024;
/** Files up to this size can be shown in the viewer. */
export const PREVIEW_LIMIT = 8 * 1024 * 1024;

/**
 * The bytes of one regular file, through a streamed GET /archive (so the 8 MiB limit of api.http does not apply).
 * Throws FsError('toolarge') when the file is over `limit`.
 */
export async function readFile(id: string, path: string, limit = SAVE_LIMIT): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    let handle: { close(): void } | undefined;
    let over = false;
    handle = docker.stream('GET', `/containers/${enc(id)}/archive`, { query: { path } }, {
      onData: (c) => {
        if (over) return;
        total += c.length;
        if (total > limit + 64 * 1024) {
          over = true;
          handle?.close();
          reject(new FsError('toolarge', 'The file is too large to open here'));
          return;
        }
        chunks.push(c);
      },
      onEnd: () => resolve(),
      onError: (e) => reject(archiveError(e, 'Docker could not read the file')),
    });
  });
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  let files;
  try {
    files = parseTar(bytes, limit, 4);
  } catch (e) {
    throw new FsError('toolarge', (e as Error).message);
  }
  if (!files.length) throw new FsError('other', 'This is not a regular file.');
  return files[0].data;
}

export type Saved = { kind: 'file' | 'tar'; filename: string; size?: number };

/**
 * Saves a file of the container through the browser. Up to SAVE_LIMIT it is taken out of its tar here and saved under
 * its own name; a bigger one (any size) is streamed to disk as the tar the Engine sends, named "<name>.tar".
 */
export async function saveFileOf(id: string, path: string, name: string, size: number, known?: Uint8Array, o?: DownloadOptions): Promise<Saved> {
  try {
    if (known || size <= SAVE_LIMIT) {
      const data = known ?? (await readFile(id, path));
      const r = await getSdk().saveFile(name, data);
      return { kind: 'file', filename: r.filename, size: r.size };
    }
    const r = await docker.download(`/containers/${enc(id)}/archive`, { path }, `${name}.tar`, o);
    return { kind: 'tar', filename: r.filename, size: r.size };
  } catch (e) {
    throw archiveError(e, 'Docker could not read the file');
  }
}

/** Streams a folder (or any path) to disk as a tar. */
export async function saveFolder(id: string, path: string, name: string, o?: DownloadOptions): Promise<Saved> {
  try {
    const r = await docker.download(`/containers/${enc(id)}/archive`, { path }, `${name || 'root'}.tar`, o);
    return { kind: 'tar', filename: r.filename, size: r.size };
  } catch (e) {
    throw archiveError(e, 'Docker could not read the folder');
  }
}

export interface Transfer {
  cancel(): void;
  done: Promise<void>;
}

/** Wraps an upload so a non-2xx answer of the Engine becomes an FsError, and cancel() is easy to reach. */
export function sendTar(id: string, dir: string, tar: Blob, onProgress?: (p: { loaded: number; total: number }) => void): Transfer {
  const up = docker.upload('PUT', `/containers/${enc(id)}/archive`, { query: { path: dir }, headers: { 'Content-Type': 'application/x-tar' } }, tar, onProgress);
  return {
    cancel: () => up.cancel(),
    done: up.then(
      (r) => {
        if (r.status >= 400) throw archiveError(new DockerError(r.status, engineMessage(r)), 'Docker could not write the file');
      },
      (e) => {
        throw archiveError(e, 'Docker could not write the file');
      },
    ),
  };
}

/** Sends a file (any size: it is not read into memory) into a folder of the container. */
export function uploadFile(id: string, dir: string, file: File, onProgress?: (p: { loaded: number; total: number }) => void): Transfer {
  return sendTar(id, dir, tarBlob([{ name: file.name, data: file, mtime: Math.floor(file.lastModified / 1000) }]), onProgress);
}

export async function makeDir(id: string, dir: string, name: string): Promise<void> {
  await sendTar(id, dir, tarBlob([{ name: `${name}/` }])).done;
}

export async function removePath(id: string, path: string): Promise<void> {
  const p = normalizePath(path);
  if (p === '/') throw new FsError('other', 'The root folder cannot be deleted.');
  const r = await execRun(id, ['rm', '-rf', '--', p]);
  if (r.code !== 0) throw new FsError(/Permission denied|Read-only/i.test(r.stderr) ? 'denied' : 'other', r.stderr.trim() || `rm exited with ${r.code}`);
}
