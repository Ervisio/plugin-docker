/**
 * A small read-only reader for BoltDB / bbolt files (the format of Portainer's portainer.db). Pure code, no SDK.
 *
 *   const db = new BoltDB(bytes);
 *   const stacks = db.root.bucket('stacks');            // nested bucket or null
 *   stacks?.forEach((key, value) => { ... });           // value is a Uint8Array; sub-buckets are skipped
 *   db.root.bucketNames();
 *
 * Layout: the file is a run of pages (usually 4096 bytes). Pages 0 and 1 are meta pages; the valid one with the
 * highest transaction id names the root bucket's page. A bucket is a B+tree of branch pages (keys and child page ids)
 * and leaf pages (keys, values, and flagged entries whose value is a sub-bucket header). A small sub-bucket is
 * stored "inline": its header has root page 0 and one leaf page follows it inside the value.
 * Reads never write, never follow a page id outside the file and stop at a depth limit, so a damaged file throws
 * BoltError instead of looping.
 */

export class BoltError extends Error {}

const MAGIC = 0xed0cdaed;
const VERSION = 2;
const PAGE_HEADER = 16;
const BRANCH = 0x01;
const LEAF = 0x02;
const META = 0x04;
const BUCKET_LEAF_FLAG = 0x01;
const MAX_DEPTH = 64;

export type Visitor = (key: Uint8Array, value: Uint8Array) => void;

/** A page, or the part of an inline bucket value that holds one. */
interface PageView {
  /** Bytes of the page including its 16 byte header. */
  buf: Uint8Array;
  dv: DataView;
}

export class BoltDB {
  readonly pageSize: number;
  readonly root: Bucket;
  private readonly data: Uint8Array;
  private readonly dv: DataView;

  constructor(data: Uint8Array) {
    this.data = data;
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < 4096) throw new BoltError('This file is too small to be a BoltDB database.');
    // Meta page 0 tells the page size; meta page 1 sits at that offset.
    const m0 = this.readMeta(0, 4096);
    const guess = m0?.pageSize ?? 4096;
    const m1 = this.readMeta(guess, guess);
    const metas = [m0, m1].filter((m): m is Meta => !!m);
    if (!metas.length) throw new BoltError('This is not a BoltDB file (no valid meta page).');
    const meta = metas.sort((a, b) => b.txid - a.txid)[0];
    this.pageSize = meta.pageSize;
    this.root = new Bucket(this, meta.root, undefined);
  }

  private readMeta(offset: number, pageSize: number): Meta | null {
    if (offset + PAGE_HEADER + 64 > this.data.length) return null;
    const flags = this.dv.getUint16(offset + 8, true);
    if (!(flags & META)) return null;
    const o = offset + PAGE_HEADER;
    if (this.dv.getUint32(o, true) !== MAGIC || this.dv.getUint32(o + 4, true) !== VERSION) return null;
    const size = this.dv.getUint32(o + 8, true);
    if (size < 512 || size > 1 << 20 || (size & (size - 1)) !== 0) return null;
    void pageSize;
    return { pageSize: size, root: Number(this.dv.getBigUint64(o + 16, true)), txid: Number(this.dv.getBigUint64(o + 56, true)) };
  }

  /** The page with this id, with its overflow pages (a big value spans several). */
  page(id: number): PageView {
    const off = id * this.pageSize;
    if (!Number.isSafeInteger(off) || off < 0 || off + PAGE_HEADER > this.data.length) throw new BoltError(`Page ${id} is outside the file.`);
    const overflow = this.dv.getUint32(off + 12, true);
    const end = off + (overflow + 1) * this.pageSize;
    if (end > this.data.length) throw new BoltError(`Page ${id} runs past the end of the file.`);
    const buf = this.data.subarray(off, end);
    return { buf, dv: new DataView(buf.buffer, buf.byteOffset, buf.byteLength) };
  }
}

interface Meta {
  pageSize: number;
  root: number;
  txid: number;
}

/** Walks one page: a branch recurses into its children, a leaf calls `leaf` for each entry. */
function walk(db: BoltDB, view: PageView, depth: number, leaf: (flags: number, key: Uint8Array, value: Uint8Array) => void): void {
  if (depth > MAX_DEPTH) throw new BoltError('The tree is too deep: the file is damaged.');
  const { buf, dv } = view;
  const flags = dv.getUint16(8, true);
  const count = dv.getUint16(10, true);
  if (flags & BRANCH) {
    for (let i = 0; i < count; i++) {
      const e = PAGE_HEADER + i * 16;
      if (e + 16 > buf.length) throw new BoltError('A branch page is cut short.');
      const pgid = Number(dv.getBigUint64(e + 8, true));
      walk(db, db.page(pgid), depth + 1, leaf);
    }
    return;
  }
  if (flags & LEAF) {
    for (let i = 0; i < count; i++) {
      const e = PAGE_HEADER + i * 16;
      if (e + 16 > buf.length) throw new BoltError('A leaf page is cut short.');
      const eflags = dv.getUint32(e, true);
      const pos = dv.getUint32(e + 4, true);
      const ksize = dv.getUint32(e + 8, true);
      const vsize = dv.getUint32(e + 12, true);
      const kstart = e + pos;
      if (kstart + ksize + vsize > buf.length) throw new BoltError('A leaf entry runs past its page.');
      leaf(eflags, buf.subarray(kstart, kstart + ksize), buf.subarray(kstart + ksize, kstart + ksize + vsize));
    }
    return;
  }
  throw new BoltError('Unexpected page type: the file is damaged or not a BoltDB file.');
}

const dec = new TextDecoder();

export class Bucket {
  private readonly db: BoltDB;
  private readonly rootPage: number;
  /** The inline page of a small bucket (rootPage is then 0). */
  private readonly inline: Uint8Array | undefined;

  constructor(db: BoltDB, rootPage: number, inline: Uint8Array | undefined) {
    this.db = db;
    this.rootPage = rootPage;
    this.inline = inline;
  }

  private top(): PageView {
    if (this.rootPage === 0 && this.inline) {
      // The value is: bucket header (16 bytes) then a page image. Entries inside use offsets relative to that page.
      const buf = this.inline;
      return { buf, dv: new DataView(buf.buffer, buf.byteOffset, buf.byteLength) };
    }
    return this.db.page(this.rootPage);
  }

  /** Every entry, in key order. `isBucket` entries carry the sub-bucket header as their value. */
  entries(): { key: Uint8Array; value: Uint8Array; isBucket: boolean }[] {
    const out: { key: Uint8Array; value: Uint8Array; isBucket: boolean }[] = [];
    walk(this.db, this.top(), 0, (flags, key, value) => out.push({ key, value, isBucket: (flags & BUCKET_LEAF_FLAG) !== 0 }));
    return out;
  }

  /** Calls `fn` for the plain key/value entries (sub-buckets are skipped). */
  forEach(fn: Visitor): void {
    for (const e of this.entries()) if (!e.isBucket) fn(e.key, e.value);
  }

  /** Plain entries as [key, value] pairs. */
  pairs(): [Uint8Array, Uint8Array][] {
    return this.entries().filter((e) => !e.isBucket).map((e) => [e.key, e.value]);
  }

  bucketNames(): string[] {
    return this.entries().filter((e) => e.isBucket).map((e) => dec.decode(e.key));
  }

  /** A nested bucket by name, or null. */
  bucket(name: string): Bucket | null {
    const want = new TextEncoder().encode(name);
    for (const e of this.entries()) {
      if (!e.isBucket || e.key.length !== want.length || !e.key.every((b, i) => b === want[i])) continue;
      if (e.value.length < 16) throw new BoltError('A bucket header is cut short.');
      const dv = new DataView(e.value.buffer, e.value.byteOffset, e.value.byteLength);
      const root = Number(dv.getBigUint64(0, true));
      if (root === 0) return new Bucket(this.db, 0, e.value.subarray(16));
      return new Bucket(this.db, root, undefined);
    }
    return null;
  }

  /** The value of a plain key, or null. */
  get(key: Uint8Array | string): Uint8Array | null {
    const want = typeof key === 'string' ? new TextEncoder().encode(key) : key;
    for (const e of this.entries()) {
      if (!e.isBucket && e.key.length === want.length && e.key.every((b, i) => b === want[i])) return e.value;
    }
    return null;
  }
}

/** Key of an integer id the way Portainer stores it: 8 bytes, big endian. */
export function idKey(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
  return b;
}

export const bytesToText = (b: Uint8Array): string => dec.decode(b);
