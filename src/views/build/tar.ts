/** A small tar writer (ustar, with pax headers for long names): packs the files a user picked into a build context. */

export interface TarFile {
  /** Path inside the archive, with forward slashes and no leading slash. */
  path: string;
  data: Uint8Array;
  /** Unix mode; 0o644 by default. */
  mode?: number;
  /** Seconds since the epoch; now by default. */
  mtime?: number;
}

const enc = new TextEncoder();

function put(buf: Uint8Array, off: number, text: string, len: number): void {
  const b = enc.encode(text);
  buf.set(b.subarray(0, len), off);
}

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function header(name: string, size: number, mode: number, mtime: number, type: string, prefix = ''): Uint8Array {
  const h = new Uint8Array(512);
  put(h, 0, name, 100);
  put(h, 100, octal(mode, 8), 8);
  put(h, 108, octal(0, 8), 8);
  put(h, 116, octal(0, 8), 8);
  put(h, 124, octal(size, 12), 12);
  put(h, 136, octal(mtime, 12), 12);
  put(h, 148, '        ', 8); // checksum counts these as spaces
  put(h, 156, type, 1);
  put(h, 257, 'ustar\0', 6);
  put(h, 263, '00', 2);
  put(h, 345, prefix, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(h, 148, sum.toString(8).padStart(6, '0') + '\0 ', 8);
  return h;
}

const pad = (n: number): number => (512 - (n % 512)) % 512;

/** One pax record: "<length> key=value\n", where length counts the whole record, digits included. */
function paxRecord(key: string, value: string): Uint8Array {
  const body = enc.encode(` ${key}=${value}\n`);
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return new Uint8Array([...enc.encode(String(len)), ...body]);
}

/** Packs the files into an uncompressed tar archive. */
export function packTar(files: TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const now = Math.floor(Date.now() / 1000);
  const block = (data: Uint8Array) => {
    parts.push(data);
    if (pad(data.length)) parts.push(new Uint8Array(pad(data.length)));
  };
  for (const f of files) {
    const mtime = f.mtime ?? now;
    const bytes = enc.encode(f.path);
    let name = f.path;
    let prefix = '';
    if (bytes.length > 100 || /[^\x00-\x7f]/.test(f.path)) {
      // Try the ustar prefix split; fall back to a pax header, which also covers non-ASCII names.
      const cut = /[^\x00-\x7f]/.test(f.path) ? -1 : f.path.lastIndexOf('/', 155);
      const tail = cut > 0 ? f.path.slice(cut + 1) : '';
      if (cut > 0 && enc.encode(tail).length <= 100 && cut <= 155) {
        prefix = f.path.slice(0, cut);
        name = tail;
      } else {
        const rec = paxRecord('path', f.path);
        parts.push(header('PaxHeader', rec.length, 0o644, mtime, 'x'));
        block(rec);
        name = f.path.replace(/[^\x20-\x7e]/g, '_').slice(-100);
      }
    }
    parts.push(header(name, f.data.length, f.mode ?? 0o644, mtime, '0', prefix));
    block(f.data);
  }
  parts.push(new Uint8Array(1024));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Everything a picked File is turned into: its path inside the context and its bytes. */
export interface Picked {
  path: string;
  file: File;
}

/** Paths for a folder pick: webkitRelativePath without the folder's own name. Plain files use their name. */
export function pickedFrom(list: FileList | File[], stripRoot: boolean): Picked[] {
  return [...list].map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return { file, path: stripRoot ? rel.split('/').slice(1).join('/') || file.name : rel };
  });
}

/** Reads the picked files and packs them. */
export async function packPicked(picked: Picked[]): Promise<Uint8Array> {
  const files: TarFile[] = [];
  for (const p of picked) {
    const data = new Uint8Array(await p.file.arrayBuffer());
    // The browser does not tell file modes: scripts (a "#!" first line) stay runnable.
    const script = data.length > 2 && data[0] === 0x23 && data[1] === 0x21;
    files.push({ path: p.path.replace(/^\/+/, ''), data, mode: script ? 0o755 : 0o644, mtime: Math.floor(p.file.lastModified / 1000) });
  }
  return packTar(files);
}

/** gzip with the browser's CompressionStream; returns the input unchanged when the browser has none. */
export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return data;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
