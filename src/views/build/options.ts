/** Build options and the pure helpers around them (no console imports, so they are unit tested). */

export interface BuildOptions {
  tags: string[];
  /** Path of the Dockerfile inside the context. */
  dockerfile: string;
  buildArgs: Record<string, string>;
  target: string;
  noCache: boolean;
  pull: boolean;
  platform: string;
  labels: Record<string, string>;
}

/** The query string of POST /build. */
export function buildQuery(o: BuildOptions, remote?: string): Record<string, string | string[]> {
  const q: Record<string, string | string[]> = { rm: '1' };
  if (o.tags.length) q.t = o.tags;
  if (remote) q.remote = remote;
  if (o.dockerfile && o.dockerfile !== 'Dockerfile') q.dockerfile = o.dockerfile;
  if (Object.keys(o.buildArgs).length) q.buildargs = JSON.stringify(o.buildArgs);
  if (Object.keys(o.labels).length) q.labels = JSON.stringify(o.labels);
  if (o.target) q.target = o.target;
  if (o.noCache) q.nocache = '1';
  if (o.pull) q.pull = '1';
  if (o.platform) q.platform = o.platform;
  return q;
}

/** "KEY=value" per line (blank lines and # comments ignored) -> object. Returns the first bad line number too. */
export function parsePairs(text: string): { pairs: Record<string, string>; bad?: number } {
  const pairs: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith('#')) continue;
    const eq = l.indexOf('=');
    if (eq < 1) return { pairs, bad: i + 1 };
    pairs[l.slice(0, eq).trim()] = l.slice(eq + 1);
  }
  return { pairs };
}

/**
 * Largest request body the plugin sends, in bytes (the context after gzip). The Engine takes 8 MB, but a streamed
 * request travels in one console WebSocket message (512 KiB, base64 coded), so about 380 KiB is the most that fits.
 * A later core release lifts it.
 */
export const MAX_CONTEXT = 380 * 1024;

/** Larger raw contexts are not even packed: they could not fit after compression either. */
export const MAX_RAW_CONTEXT = 64 << 20;
