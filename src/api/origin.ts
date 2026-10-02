/**
 * Stacks whose files live inside another container. Portainer runs `docker compose` in its own container: the
 * project's working directory (/data/compose/<id>) is a path of Portainer's volume, not of this machine. Pure helpers
 * only (no SDK), so they can be tested on their own:
 *
 *   originCandidates()  which containers mount a prefix of that path
 *   parseTar()          read the answer of GET /containers/{id}/archive
 *   rewriteBinds()      make the relative bind mounts of the compose file absolute, with the host paths in use
 */
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

/* ---------- origin ---------- */

export interface MountLike {
  Type: string;
  Name?: string;
  Source: string;
  Destination: string;
}

export interface ContainerLike {
  Id: string;
  Names?: string[];
  Image: string;
  Labels?: Record<string, string>;
  Mounts?: MountLike[];
}

export interface Origin {
  kind: 'portainer' | 'container';
  /** Name of the container that holds the files. */
  container: string;
  containerId: string;
  /** Portainer stack id (from /data/compose/<id>), when known. */
  stackId?: number;
  /** Where the files are on this machine: the mount's Source plus the rest of the path. */
  hostPath?: string;
  /** Name of the volume that holds the files, when the mount is a volume. */
  volume?: string;
  /** The folder inside the container (the project's working directory). */
  dir: string;
}

export interface Candidate {
  container: ContainerLike;
  mount: MountLike;
  rest: string;
}

const PORTAINER_IMAGE = /(^|\/)portainer\/portainer(-ce|-ee)?([:@]|$)/;
export const isPortainerImage = (image: string): boolean => PORTAINER_IMAGE.test(image);

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);
export const containerNameOf = (c: ContainerLike): string => c.Names?.[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12);

/** The id of a Portainer stack from its working directory, "/data/compose/12" gives 12. */
export function portainerStackId(dir: string): number | undefined {
  const m = /\/compose\/(\d+)\/?$/.exec(dir);
  return m ? Number(m[1]) : undefined;
}

/**
 * Containers outside the project that mount a folder holding `path`, best first: Portainer, then the deepest mount.
 * A bind mount whose source equals its destination is skipped: its files are on this machine at the same path.
 */
export function originCandidates(path: string, project: string, list: ContainerLike[]): Candidate[] {
  const p = trimSlash(path);
  const out: Candidate[] = [];
  for (const c of list) {
    if (c.Labels?.['com.docker.compose.project'] === project) continue;
    for (const m of c.Mounts ?? []) {
      const dest = trimSlash(m.Destination);
      if (dest === '/' || !(p === dest || p.startsWith(dest + '/'))) continue;
      if (m.Type === 'bind' && trimSlash(m.Source) === dest) continue;
      out.push({ container: c, mount: m, rest: p.slice(dest.length) });
    }
  }
  const score = (c: Candidate) => (isPortainerImage(c.container.Image) ? 1e6 : 0) + c.mount.Destination.length;
  return out.sort((a, b) => score(b) - score(a));
}

export function originOf(cand: Candidate, dir: string): Origin {
  const m = cand.mount;
  const root = trimSlash(dir);
  const base = trimSlash(m.Destination);
  const rest = root.startsWith(base) ? root.slice(base.length) : '';
  return {
    kind: isPortainerImage(cand.container.Image) ? 'portainer' : 'container',
    container: containerNameOf(cand.container),
    containerId: cand.container.Id,
    stackId: portainerStackId(dir),
    hostPath: m.Source ? m.Source.replace(/\/+$/, '') + rest : undefined,
    volume: m.Type === 'volume' ? m.Name : undefined,
    dir,
  };
}

/* ---------- tar ---------- */

export interface TarFile {
  name: string;
  data: Uint8Array;
}

export const TAR_MAX_BYTES = 2 * 1024 * 1024;
export const TAR_MAX_FILES = 64;

const dec = new TextDecoder();
const cstr = (b: Uint8Array, from: number, len: number): string => {
  let end = from;
  while (end < from + len && b[end] !== 0) end++;
  return dec.decode(b.subarray(from, end));
};

function octal(b: Uint8Array, from: number, len: number): number {
  if (b[from] & 0x80) {
    // base-256 (GNU), big-endian, first bit is a flag
    let n = b[from] & 0x7f;
    for (let i = from + 1; i < from + len; i++) n = n * 256 + b[i];
    return n;
  }
  const s = cstr(b, from, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error('Corrupt tar header');
  return parseInt(s, 8);
}

function paxRecords(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    let sp = i;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    const len = parseInt(dec.decode(data.subarray(i, sp)), 10);
    if (!len || i + len > data.length) break;
    const rec = dec.decode(data.subarray(sp + 1, i + len - 1));
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Read the regular files of a tar (ustar, GNU long names, pax headers). Links, directories and devices are skipped.
 * Throws when the archive holds more than `maxBytes` of file data or more than `maxFiles` files.
 */
export function parseTar(bytes: Uint8Array, maxBytes = TAR_MAX_BYTES, maxFiles = TAR_MAX_FILES): TarFile[] {
  const files: TarFile[] = [];
  let total = 0;
  let longName: string | undefined;
  let pax: Record<string, string> = {};
  let pos = 0;
  while (pos + 512 <= bytes.length) {
    const h = bytes.subarray(pos, pos + 512);
    if (h.every((x) => x === 0)) break;
    let size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    let name = cstr(h, 0, 100);
    if (cstr(h, 257, 5) === 'ustar') {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    pos += 512;
    if (type === 'x' || type === 'L') {
      if (size > 64 * 1024 || pos + size > bytes.length) throw new Error('Corrupt tar header');
      const body = bytes.subarray(pos, pos + size);
      if (type === 'L') longName = cstr(body, 0, body.length);
      else pax = { ...pax, ...paxRecords(body) };
      pos += Math.ceil(size / 512) * 512;
      continue;
    }
    if (pax.size !== undefined && /^\d+$/.test(pax.size)) size = Number(pax.size);
    if (pax.path) name = pax.path;
    if (longName !== undefined) name = longName;
    longName = undefined;
    pax = {};
    const regular = type === '0';
    // Types g (global pax header), links, directories and special files carry no file data we need.
    const skipData = type === '1' || type === '2' || type === '3' || type === '4' || type === '5' || type === '6' ? 0 : size;
    if (regular) {
      total += size;
      if (total > maxBytes) throw new Error('The archive is too large');
      if (files.length >= maxFiles) throw new Error('The archive holds too many files');
      if (pos + size > bytes.length) throw new Error('The archive is cut short');
      files.push({ name: name.replace(/^\.\//, ''), data: bytes.slice(pos, pos + size) });
    }
    pos += Math.ceil(skipData / 512) * 512;
  }
  return files;
}

/** One header of a tar, without its data. */
export interface TarEntry {
  name: string;
  /** '0' file, '5' directory, '2' symlink, and so on (the tar type flag). */
  type: string;
  size: number;
  /** Permission bits (0o755). */
  mode: number;
  /** Seconds since the epoch. */
  mtime: number;
  uid: number;
  gid: number;
  linkname: string;
}

/**
 * List the headers of a tar (all entry kinds), skipping the data. Used to read a directory listing from
 * GET /containers/{id}/archive. Throws when the archive holds more than `maxEntries` entries.
 */
export function listTar(bytes: Uint8Array, maxEntries = 20000): TarEntry[] {
  const out: TarEntry[] = [];
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  let pos = 0;
  while (pos + 512 <= bytes.length) {
    const h = bytes.subarray(pos, pos + 512);
    if (h.every((x) => x === 0)) break;
    let size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    let name = cstr(h, 0, 100);
    if (cstr(h, 257, 5) === 'ustar') {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const mode = octal(h, 100, 8) & 0o7777;
    const uid = octal(h, 108, 8);
    const gid = octal(h, 116, 8);
    let mtime = octal(h, 136, 12);
    let linkname = cstr(h, 157, 100);
    pos += 512;
    if (type === 'x' || type === 'L' || type === 'K') {
      if (size > 64 * 1024 || pos + size > bytes.length) throw new Error('Corrupt tar header');
      const body = bytes.subarray(pos, pos + size);
      if (type === 'L') longName = cstr(body, 0, body.length);
      else if (type === 'K') longLink = cstr(body, 0, body.length);
      else pax = { ...pax, ...paxRecords(body) };
      pos += Math.ceil(size / 512) * 512;
      continue;
    }
    if (type === 'g') {
      pos += Math.ceil(size / 512) * 512;
      continue;
    }
    if (pax.size !== undefined && /^\d+$/.test(pax.size)) size = Number(pax.size);
    if (pax.path) name = pax.path;
    if (pax.linkpath) linkname = pax.linkpath;
    if (pax.mtime && !Number.isNaN(parseFloat(pax.mtime))) mtime = Math.floor(parseFloat(pax.mtime));
    if (longName !== undefined) name = longName;
    if (longLink !== undefined) linkname = longLink;
    longName = longLink = undefined;
    pax = {};
    if (out.length >= maxEntries) throw new Error('The archive holds too many entries');
    out.push({ name, type, size: type === '0' || type === '7' ? size : 0, mode, mtime, uid, gid, linkname });
    const skipData = type === '1' || type === '2' || type === '3' || type === '4' || type === '5' || type === '6' ? 0 : size;
    pos += Math.ceil(skipData / 512) * 512;
  }
  return out;
}

/* ---------- bind mounts ---------- */

export interface BindChange {
  service: string;
  from: string;
  to: string;
  /** container: taken from a container's real mount; path: the folder resolved against the working directory. */
  source: 'container' | 'path';
}

export interface BindWarning {
  kind: 'build' | 'file' | 'tilde' | 'variable';
  service?: string;
  value: string;
}

export interface BindRewrite {
  text: string;
  changes: BindChange[];
  warnings: BindWarning[];
  /** Relative env_file paths the compose file reads: they must be copied next to it. */
  envFiles: string[];
}

const isRelativeSource = (s: string): boolean => s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../');

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

/**
 * Make every relative bind source of a compose file absolute. Compose resolved them against the project's working
 * directory when the project was started, so the Docker daemon created (or already had) those folders on this
 * machine at that literal path. The host path of a service's mount is taken from its running containers, matched by
 * service and destination; when there is none, the source is resolved against `workdir`. The file is parsed and
 * written back with its comments and layout. Handles `./a:/b:ro` and `type: bind` with `source`.
 */
export function rewriteBinds(text: string, workdir: string, containers: ContainerLike[]): BindRewrite {
  const doc = parseDocument(text);
  const res: BindRewrite = { text, changes: [], warnings: [], envFiles: [] };
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  const services = doc.get('services', true);
  if (!isMap(services)) return res;
  const base = trimSlash(workdir);

  const resolve = (service: string, rel: string, dest: string | undefined): { path: string; source: 'container' | 'path' } => {
    if (dest) {
      for (const c of containers) {
        if (c.Labels?.['com.docker.compose.service'] !== service) continue;
        const m = c.Mounts?.find((x) => x.Type === 'bind' && trimSlash(x.Destination) === trimSlash(dest));
        if (m?.Source) return { path: trimSlash(m.Source), source: 'container' };
      }
    }
    return { path: normalize(`${base}/${rel}`), source: 'path' };
  };

  const noteFile = (service: string, value: unknown, kind: BindWarning['kind']) => {
    if (typeof value === 'string' && isRelativeSource(value)) res.warnings.push({ kind, service, value });
  };

  for (const pair of services.items) {
    const service = String((pair.key as { value?: unknown }).value ?? '');
    const svc = pair.value;
    if (!isMap(svc)) continue;

    const vols = svc.get('volumes', true);
    if (isSeq(vols)) {
      for (const item of vols.items) {
        if (isScalar(item) && typeof item.value === 'string') {
          const spec = item.value;
          const i = spec.indexOf(':');
          if (i <= 0) continue;
          const src = spec.slice(0, i);
          if (src.startsWith('$')) {
            res.warnings.push({ kind: 'variable', service, value: spec });
            continue;
          }
          if (src.startsWith('~')) {
            res.warnings.push({ kind: 'tilde', service, value: spec });
            continue;
          }
          if (!isRelativeSource(src)) continue;
          const rest = spec.slice(i + 1);
          const dest = rest.split(':')[0];
          const r = resolve(service, src, dest);
          item.value = `${r.path}:${rest}`;
          res.changes.push({ service, from: src, to: r.path, source: r.source });
        } else if (isMap(item)) {
          if (item.get('type') !== 'bind') continue;
          const srcNode = item.get('source', true);
          if (!isScalar(srcNode) || typeof srcNode.value !== 'string') continue;
          const src = srcNode.value;
          if (src.startsWith('$')) {
            res.warnings.push({ kind: 'variable', service, value: src });
            continue;
          }
          if (!isRelativeSource(src)) continue;
          const dest = item.get('target');
          const r = resolve(service, src, typeof dest === 'string' ? dest : undefined);
          srcNode.value = r.path;
          res.changes.push({ service, from: src, to: r.path, source: r.source });
        }
      }
    }

    const envFile = (svc.toJSON() as { env_file?: unknown }).env_file;
    const list: unknown[] = Array.isArray(envFile) ? envFile : typeof envFile === 'string' ? [envFile] : [];
    for (const e of list) {
      const p = typeof e === 'string' ? e : (e as { path?: unknown })?.path;
      if (typeof p === 'string' && !p.startsWith('/') && !p.includes('..') && !p.includes('$')) {
        const clean = p.replace(/^\.\//, '');
        if (!res.envFiles.includes(clean)) res.envFiles.push(clean);
      }
    }

    const build = (svc.toJSON() as { build?: unknown }).build;
    if (typeof build === 'string') noteFile(service, build, 'build');
    else if (build && typeof build === 'object') noteFile(service, (build as { context?: unknown }).context, 'build');
  }

  for (const key of ['configs', 'secrets']) {
    const top = doc.get(key, true);
    if (!isMap(top)) continue;
    for (const p of top.items) {
      const v = p.value;
      if (isMap(v)) noteFile('', v.get('file'), 'file');
    }
  }

  res.text = res.changes.length ? doc.toString({ lineWidth: 0 }) : text;
  return res;
}

/** Environment files of a project: the label's list, else stack.env, else .env, as paths inside the working directory. */
export function envFileNames(label: string | undefined, dir: string): string[] {
  const named = (label ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (named.length) return named.map((p) => (p.startsWith('/') ? p : `${trimSlash(dir)}/${p}`));
  return [`${trimSlash(dir)}/stack.env`, `${trimSlash(dir)}/.env`];
}
