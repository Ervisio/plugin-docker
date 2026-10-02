/** Pure helpers of image export and import (unit tested). */

const day = (d = new Date()): string => d.toISOString().slice(0, 10).replace(/-/g, '');

/** A file name for the export of these references: "busybox-1.36.tar" for one, "ervisio-images-20261002.tar" for several. */
export function exportName(names: string[]): string {
  if (names.length === 1 && !/^sha256:|^[0-9a-f]{12,64}$/.test(names[0])) return `${names[0].replace(/[/:@]+/g, '-').replace(/[^a-zA-Z0-9_.-]/g, '_')}.tar`;
  return `ervisio-images-${day()}.tar`;
}

/** Pulls the image names out of the lines Docker writes while it loads. */
export function parseLoaded(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^Loaded image(?: ID)?: (.+)$/.exec(line.trim());
    if (m) out.push(m[1].trim());
  }
  return out;
}

