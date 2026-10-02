/** A small tar writer (ustar, with GNU long names and pax for the rest), for PUT /containers/{id}/archive. */

export interface TarWrite {
  /** Path inside the archive. A trailing slash makes it a directory. */
  name: string;
  /** File contents; omit for a directory. */
  data?: Uint8Array;
  mode?: number;
  /** Seconds since the epoch (default: now). */
  mtime?: number;
  uid?: number;
  gid?: number;
}

const enc = new TextEncoder();

function put(h: Uint8Array, at: number, text: string, len: number): void {
  h.set(enc.encode(text).subarray(0, len), at);
}
const oct = (n: number, len: number): string => Math.max(0, Math.floor(n)).toString(8).padStart(len - 1, '0') + '\0';

function header(name: Uint8Array, type: string, size: number, mode: number, mtime: number, uid: number, gid: number): Uint8Array {
  const h = new Uint8Array(512);
  h.set(name.subarray(0, 100), 0);
  put(h, 100, oct(mode, 8), 8);
  put(h, 108, oct(uid, 8), 8);
  put(h, 116, oct(gid, 8), 8);
  put(h, 124, oct(size, 12), 12);
  put(h, 136, oct(mtime, 12), 12);
  h[156] = type.charCodeAt(0);
  put(h, 257, 'ustar\0', 6);
  put(h, 263, '00', 2);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const x of h) sum += x;
  put(h, 148, sum.toString(8).padStart(6, '0') + '\0 ', 8);
  return h;
}

const padded = (n: number): number => Math.ceil(n / 512) * 512;

/** Build a tar archive of the given entries (two zero blocks at the end). */
export function writeTar(entries: TarWrite[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const e of entries) {
    const dir = e.name.endsWith('/');
    const nameBytes = enc.encode(e.name);
    const data = dir ? new Uint8Array(0) : (e.data ?? new Uint8Array(0));
    const mode = e.mode ?? (dir ? 0o755 : 0o644);
    if (nameBytes.length > 100) {
      // GNU long name: a pseudo entry of type L whose data is the name.
      const body = new Uint8Array(nameBytes.length + 1);
      body.set(nameBytes);
      parts.push(header(enc.encode('././@LongLink'), 'L', body.length, 0, 0, 0, 0));
      const pad = new Uint8Array(padded(body.length));
      pad.set(body);
      parts.push(pad);
    }
    parts.push(header(nameBytes, dir ? '5' : '0', data.length, mode, e.mtime ?? now, e.uid ?? 0, e.gid ?? 0));
    if (data.length) {
      const pad = new Uint8Array(padded(data.length));
      pad.set(data);
      parts.push(pad);
    }
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
