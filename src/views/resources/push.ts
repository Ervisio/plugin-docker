import { stream, type StreamHandle } from '../../api/engine';
import { JsonLines } from '../../api/streams';
import { refPath } from './imageRef';
import type { PullLayer, PullState } from './pull';

interface PushLine {
  id?: string;
  status?: string;
  error?: string;
  progressDetail?: { current?: number; total?: number };
  aux?: { Tag?: string; Digest?: string; Size?: number };
}

const DONE = /^(Pushed|Layer already exists|Mounted from .*)$/;

/**
 * Pushes `name:tag` and reports progress per layer after every change (same state shape as a pull).
 * `auth` is the X-Registry-Auth value. close() cancels the upload.
 */
export function pushImage(name: string, tag: string, auth: string, onState: (s: PullState & { digest?: string }) => void): StreamHandle {
  const layers = new Map<string, PullLayer>();
  let message = '';
  let digest: string | undefined;
  let error: string | undefined;
  let finished = false;
  const emit = () => onState({ layers: [...layers.values()], message, finished, error, digest });

  const lines = new JsonLines<PushLine>((l) => {
    if (l.error) {
      error = l.error;
      emit();
      return;
    }
    if (l.aux?.Digest) digest = l.aux.Digest;
    if (l.id && l.status) {
      const prev = layers.get(l.id) ?? { id: l.id, status: '', current: 0, total: 0, pct: 0, done: false };
      const d = l.progressDetail;
      const done = DONE.test(l.status);
      const total = d?.total ?? prev.total;
      const current = d?.current ?? prev.current;
      let pct = prev.pct;
      if (done) pct = 1;
      else if (total > 0 && /^Pushing/.test(l.status)) pct = Math.max(pct, current / total);
      layers.set(l.id, { id: l.id, status: l.status, current, total, pct, done });
    } else if (l.status) {
      message = l.status;
    }
    emit();
  });

  const handle = stream(
    'POST',
    `/images/${refPath(name)}/push`,
    { query: { tag }, headers: { 'X-Registry-Auth': auth } },
    {
      onData: (c) => lines.push(c),
      onEnd: () => {
        lines.end();
        finished = true;
        emit();
      },
      onError: (e) => {
        error = e.message;
        finished = true;
        emit();
      },
    },
  );
  emit();
  return handle;
}
