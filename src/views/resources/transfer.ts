/**
 * Export and import of images as tar files.
 *   export  GET /images/get?names=a&names=b  streamed to disk by api.download (no size limit)
 *   import  POST /images/load  the picked .tar or .tar.gz is sent by api.upload as it is (Docker detects gzip), and the
 *           answer, JSON lines such as {"stream":"Loaded image: busybox:1.36\n"}, is read while it arrives
 */
import { docker, engineMessage } from '../../api/engine';
import { JsonLines } from '../../api/streams';
import type { DownloadOptions, DownloadStarted } from '../../sdk';
import { exportName, parseLoaded } from './transferNames';

export { exportName, parseLoaded };

/** Streams the images (references or ids) to disk as a tar. Resolves when the browser starts saving. */
export function exportImages(names: string[], o?: DownloadOptions): Promise<DownloadStarted> {
  return docker.download('/images/get', { names }, exportName(names), o);
}

export interface LoadState {
  /** Bytes of the file sent so far. */
  loaded: number;
  total: number;
  /** The file is out and Docker is unpacking it. */
  loading: boolean;
  /** "busybox:1.36" or "sha256:…", one per image Docker reported. */
  images: string[];
  error?: string;
  finished: boolean;
  cancelled?: boolean;
}

interface LoadLine {
  stream?: string;
  status?: string;
  error?: string;
  errorDetail?: { message?: string };
}

/** Sends a .tar or .tar.gz to POST /images/load. close() cancels. */
export function loadImages(file: File, onState: (s: LoadState) => void): { close(): void } {
  const st: LoadState = { loaded: 0, total: file.size, loading: false, images: [], finished: false };
  let status = 200;
  let errBody = '';
  const emit = () => onState({ ...st, images: [...st.images] });
  const finish = (error?: string) => {
    if (st.finished) return;
    st.finished = true;
    st.loading = false;
    if (error) st.error = error;
    emit();
  };
  const lines = new JsonLines<LoadLine>((l) => {
    if (l.error || l.errorDetail) return finish(l.errorDetail?.message || l.error);
    if (l.stream) st.images.push(...parseLoaded(l.stream));
    emit();
  });
  const up = docker.upload('POST', '/images/load', { query: { quiet: '0' }, headers: { 'Content-Type': 'application/x-tar' } }, file, {
    onProgress: (p) => {
      st.loaded = p.loaded;
      st.total = p.total;
      st.loading = p.loaded >= p.total;
      emit();
    },
    onResponseStart: (s) => {
      status = s;
      st.loading = true;
      emit();
    },
    onResponseData: (c) => (status >= 400 ? (errBody += new TextDecoder().decode(c)) : lines.push(c)),
  });
  emit();
  up.then(
    () => {
      if (status >= 400) return finish(engineMessage({ status, body: errBody }));
      lines.end();
      if (!st.finished && !st.images.length) st.error = undefined;
      finish();
    },
    (e: Error & { code?: string }) => {
      if (e.code === 'cancelled') st.cancelled = true;
      finish(e.code === 'cancelled' ? undefined : e.message);
    },
  );
  return { close: () => up.cancel() };
}
