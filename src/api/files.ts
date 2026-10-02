/**
 * Files inside a container, through the Engine API only (no shell needed on the host):
 *   list      exec `ls -la --full-time` when the container runs and has ls; otherwise GET /archive of the folder
 *             and read the tar headers (works on stopped containers and on images without a shell)
 *   download  GET /archive of one file, unpacked from its tar
 *   upload    PUT /archive with a tar built here
 *   mkdir     PUT /archive with a folder entry
 *   remove    exec `rm -rf` (needs a running container with rm)
 * The Engine caps every answer and request at the manifest's maxBody (8 MB), so files are limited to FILE_LIMIT.
 */
import { listTar, parseTar } from './origin';
import { writeTar } from './tar';
import { docker, DockerError } from './engine';

/** The http capability allows 8 MiB per body; the tar framing takes a few KB of that. */
export const FILE_LIMIT = 8 * 1024 * 1024 - 64 * 1024;
/**
 * The core takes one RPC request body of at most 1 MiB, and a binary body travels as base64 (4/3 larger) inside JSON,
 * so a tar of about 780 KB is the most one PUT can carry. Core 0.5 streams uploads and this can then follow FILE_LIMIT.
 */
export const UPLOAD_LIMIT = 780_000;
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

/** The bytes of one regular file (at most FILE_LIMIT; the caller checks the listed size first). */
export async function readFile(id: string, path: string): Promise<Uint8Array> {
  const bytes = await archiveGet(id, path);
  let files;
  try {
    files = parseTar(bytes, FILE_LIMIT + 1024, 4);
  } catch (e) {
    throw new FsError('toolarge', (e as Error).message);
  }
  if (!files.length) throw new FsError('other', 'This is not a regular file.');
  return files[0].data;
}

export async function writeFile(id: string, dir: string, name: string, data: Uint8Array): Promise<void> {
  if (data.length > UPLOAD_LIMIT) throw new FsError('toolarge', 'The file is too large');
  await put(id, dir, writeTar([{ name, data }]));
}

export async function makeDir(id: string, dir: string, name: string): Promise<void> {
  await put(id, dir, writeTar([{ name: `${name}/` }]));
}

async function put(id: string, dir: string, tar: Uint8Array): Promise<void> {
  try {
    const r = await docker.request('PUT', `/containers/${enc(id)}/archive`, { query: { path: dir }, headers: { 'Content-Type': 'application/x-tar' }, body: tar });
    if (r.status >= 400) {
      let msg = r.body;
      try {
        msg = (r.json() as { message?: string }).message ?? msg;
      } catch {
        /* plain */
      }
      throw new DockerError(r.status, msg.slice(0, 300));
    }
  } catch (e) {
    throw archiveError(e, 'Docker could not write the file');
  }
}

export async function removePath(id: string, path: string): Promise<void> {
  const p = normalizePath(path);
  if (p === '/') throw new FsError('other', 'The root folder cannot be deleted.');
  const r = await execRun(id, ['rm', '-rf', '--', p]);
  if (r.code !== 0) throw new FsError(/Permission denied|Read-only/i.test(r.stderr) ? 'denied' : 'other', r.stderr.trim() || `rm exited with ${r.code}`);
}

/** Saves bytes through the browser (a Blob link). Returns false when the browser refused. */
export function saveBlob(name: string, data: Uint8Array): boolean {
  try {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  } catch {
    return false;
  }
}
