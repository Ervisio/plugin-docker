import { useEffect, useRef } from 'react';
import { t } from '../../i18n';
import { formatBytes } from '../../api/format';
import { Icon, Progress } from '../../kit';
import type { BuildState, BuildStep } from './build';

const mark = (s: BuildStep['state']) => (s === 'done' ? 'check' : s === 'failed' ? 'alert' : s === 'stopped' ? 'stop' : 'refresh');

/** Live build output: one block per Dockerfile step. The step that failed is red and shows the error under it. */
export function BuildOutput({ state }: { state: BuildState }) {
  const end = useRef<HTMLDivElement>(null);
  const running = !state.finished;
  useEffect(() => {
    if (running) end.current?.scrollIntoView({ block: 'nearest' });
  });
  const last = state.steps.length - 1;
  return (
    <div className="dk-bo" role="log" aria-live="polite" aria-label={t('build.output')}>
      {state.sending && (
        <div className="dk-bo-send">
          <small>{t('build.sending', { done: formatBytes(state.sending.loaded), total: formatBytes(state.sending.total) })}</small>
          <Progress value={state.sending.total ? (state.sending.loaded / state.sending.total) * 100 : 0} />
        </div>
      )}
      {state.pre.length > 0 && <pre className="dk-bo-pre">{state.pre.join('\n')}</pre>}
      {state.steps.map((s, i) => (
        <div key={i} className={`dk-bo-step dk-bo-step--${s.state}`}>
          <div className="dk-bo-h">
            <Icon name={mark(s.state)} className={s.state === 'running' ? 'dk-spin' : undefined} />
            <small>{s.n}/{s.total}</small>
            <code>{s.title}</code>
          </div>
          {(s.state !== 'done' || i === last) && s.lines.length > 0 && <pre className="dk-bo-pre">{s.lines.join('\n')}</pre>}
          {s.state === 'failed' && state.error && <p className="dk-fail"><Icon name="alert" />{state.error}</p>}
        </div>
      ))}
      {state.error && !state.steps.some((s) => s.state === 'failed') && <p className="dk-fail"><Icon name="alert" />{state.error}</p>}
      {running && state.activity && <small className="dk-muted dk-bo-act">{state.activity}</small>}
      <div ref={end} />
    </div>
  );
}
