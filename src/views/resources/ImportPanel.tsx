import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '../../api/format';
import { t, tn } from '../../i18n';
import { Button, Icon, Progress } from '../../kit';
import { loadImages, type LoadState } from './transfer';

/**
 * Inline "Import images" card: choose a .tar or .tar.gz made by docker save or by Export, watch the upload, then see which
 * images Docker loaded. Nothing is read into the page: the file is sent as a stream.
 */
export function ImportPanel({ onClose, onDone }: { onClose(): void; onDone?(): void }) {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<LoadState | null>(null);
  const handle = useRef<{ close(): void } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const running = !!state && !state.finished;
  useEffect(() => () => handle.current?.close(), []);

  const start = () => {
    if (!file) return;
    handle.current = loadImages(file, (s) => {
      setState(s);
      if (s.finished && !s.error && !s.cancelled) onDone?.();
    });
  };

  return (
    <section className="dk-card dk-pull" aria-label={t('res.import.title')}>
      <div className="dk-card-h">
        <h3>{t('res.import.title')}</h3>
        <Button size="sm" variant="ghost" icon="close" onClick={() => { handle.current?.close(); onClose(); }}>{running ? t('res.import.cancel') : t('common.close')}</Button>
      </div>
      <p className="dk-muted">{t('res.import.text')}</p>
      <div className="dk-pull-f">
        <Button icon="file" disabled={running} onClick={() => input.current?.click()}>{t('res.import.choose')}</Button>
        <input ref={input} type="file" hidden accept=".tar,.tgz,.gz,.tar.gz,application/x-tar,application/gzip" data-testid="import-file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { setFile(f); setState(null); } }} />
        <span className="dk-grow">{file ? <><code>{file.name}</code> <span className="dk-muted">{formatBytes(file.size)}</span></> : <span className="dk-muted">{t('res.import.none')}</span>}</span>
        <Button variant="primary" icon="upload" disabled={!file || running} loading={running} onClick={start}>{t('res.import.go')}</Button>
      </div>
      {state && (
        <div className="dk-layers" aria-live="polite">
          {!state.finished && !state.loading && <><small className="dk-muted">{t('res.import.sending', { done: formatBytes(state.loaded), total: formatBytes(state.total) })}</small><Progress value={state.total ? (state.loaded / state.total) * 100 : 0} /></>}
          {state.loading && !state.finished && <small className="dk-muted">{t('res.import.loading')}</small>}
          {state.images.length > 0 && (
            <ul className="dk-ld" aria-label={t('res.import.loaded')}>
              {state.images.map((n) => <li key={n}><Icon name="check" size={14} /> <code>{n}</code></li>)}
            </ul>
          )}
          {state.error && <p className="dk-fail"><Icon name="alert" />{state.error}</p>}
          {state.cancelled && <small className="dk-muted">{t('res.import.cancelled')}</small>}
          {!state.error && state.finished && !state.cancelled && <p className="dk-okmsg"><Icon name="check" />{state.images.length ? tn('res.import.done', { n: state.images.length }) : t('res.import.doneNone')}</p>}
        </div>
      )}
    </section>
  );
}
