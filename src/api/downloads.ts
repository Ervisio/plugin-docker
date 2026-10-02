/**
 * Knowing when a download ends. The browser fetches the file by itself, so api.download resolves when it starts; the
 * end comes later through `onDone` (core 0.5.0). A watch turns that into one callback that always runs once: when
 * onDone fires, or, if it never does (older core, closed frame), after a fallback delay so no button stays busy.
 * Pure (no SDK), so it can be tested on its own.
 */
import type { DownloadResult } from '../sdk';
import { formatBytes } from './format';

export interface DownloadWatch {
  /** Pass as `onDone` to the download call. */
  onDone(r: DownloadResult): void;
  /** Call once the download call has resolved: starts the fallback timer. */
  armed(): void;
  /** Call when the download call itself failed: nothing will come. */
  abort(): void;
}

/** `end(result)` runs once. `result` is undefined when it ended by the fallback (no word from the daemon). */
export function watchDownload(end: (r?: DownloadResult) => void, fallbackMs = 30000): DownloadWatch {
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (r?: DownloadResult) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    end(r);
  };
  return {
    onDone: (r) => finish(r),
    armed: () => {
      if (!finished) timer = setTimeout(() => finish(undefined), fallbackMs);
    },
    abort: () => {
      finished = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** What to tell the user once a download ended: undefined `ok` means "no word", show nothing. */
export function describeDone(r: DownloadResult | undefined): { ok: boolean; size: string; error?: string } | undefined {
  if (!r) return undefined;
  return r.ok ? { ok: true, size: formatBytes(r.bytes) } : { ok: false, size: formatBytes(r.bytes), error: r.error };
}
