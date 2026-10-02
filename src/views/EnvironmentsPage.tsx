import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadSummary, REFRESH_MS, type EnvSummary } from '../api/envSummary';
import { healthOf, KIND_HUE, KIND_ICON, limitOf, type Health } from '../api/envHealth';
import { coreEnvSettingsUrl, envList, type CardKind } from '../api/envList';
import { errorText } from '../api/engine';
import { t, tn } from '../i18n';
import { Button, Icon, Input, Skeleton } from '../kit';
import { navigate } from '../router';
import { getSdk, type PluginEnv } from '../sdk';
import { ErrorState } from '../ui/ErrorState';
import { PageHeader } from '../ui/PageHeader';

/** One host as a card: this server, or an environment from sdk.envs.list(). */
interface Row {
  key: string;
  env: PluginEnv | undefined;
  kind: CardKind;
}

interface Sample {
  summary?: EnvSummary;
  /** Did our own call get an answer? undefined until it ran. */
  answered?: boolean;
  error?: string;
  loading: boolean;
}

/** Opens Settings > Environments of the core in a new tab (this frame cannot navigate the app itself). */
export const openCoreSettings = (): void => getSdk().openExternal(coreEnvSettingsUrl());

/** Samples every host now and every 30 seconds while the page is visible. Hosts the daemon found offline are asked only on demand. */
function useSamples(rows: Row[]): { samples: Record<string, Sample>; retry(row: Row): void } {
  const [samples, setSamples] = useState<Record<string, Sample>>({});
  const alive = useRef(true);
  const last = useRef<Record<string, number>>({});
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (row: Row) => {
    last.current[row.key] = Date.now();
    setSamples((s) => ({ ...s, [row.key]: { ...s[row.key], loading: true } }));
    let next: Sample;
    try {
      next = { summary: await loadSummary(row.env?.id, (summary) => alive.current && setSamples((s) => ({ ...s, [row.key]: { summary, answered: true, loading: true } }))), answered: true, loading: false };
    } catch (e) {
      next = { answered: false, error: errorText(e), loading: false };
    }
    if (alive.current) setSamples((s) => ({ ...s, [row.key]: next }));
  }, []);

  const rowsKey = rows.map((r) => `${r.key}:${r.env?.status?.reachable ?? ''}`).join(',');
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    const run = (force: boolean) => {
      if (document.hidden) return;
      for (const r of rowsRef.current) {
        const offline = r.env?.status && !r.env.status.reachable;
        if (offline && !force) continue;
        if (Date.now() - (last.current[r.key] ?? 0) < REFRESH_MS - 1000) continue;
        void load(r);
      }
    };
    run(false);
    const timer = setInterval(() => run(false), REFRESH_MS);
    const vis = () => run(false);
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [rowsKey, load]);

  return { samples, retry: (row) => void load(row) };
}

const pct = (v: number | null | undefined): number => Math.max(0, Math.min(100, Math.round(v ?? 0)));

/** Route { view: 'environments' }: one card per Docker host (design 043 b); Open enters the host. */
export function EnvironmentsPage() {
  const { data: envs, error, loading, updatedAt } = envList.use();
  const [q, setQ] = useState('');

  const rows = useMemo<Row[]>(() => [{ key: 'local', env: undefined, kind: 'local' as CardKind }, ...(envs ?? []).map((e) => ({ key: e.id, env: e, kind: e.kind as CardKind }))], [envs]);
  const { samples, retry } = useSamples(envs ? rows : []);

  const kindLabel = (k: CardKind) => t(`envs.kind.${k}`);
  const visible = rows.filter((r) => {
    const name = (r.env?.name ?? samples[r.key]?.summary?.host ?? t('envs.local')).toLowerCase();
    return !q.trim() || name.includes(q.trim().toLowerCase()) || kindLabel(r.kind).toLowerCase().includes(q.trim().toLowerCase());
  });

  const states = rows.map((r) => healthOf(r.kind, r.env?.status?.reachable ?? true, samples[r.key]?.answered));
  const offline = states.filter((s) => s === 'off').length;
  const running = rows.reduce((n, r) => n + (samples[r.key]?.answered ? samples[r.key]?.summary?.running ?? 0 : 0), 0);
  const subtitle = envs
    ? [tn('envs.sub.hosts', { n: rows.length }), tn('envs.sub.running', { n: running }), offline ? tn('envs.sub.offline', { n: offline }) : ''].filter(Boolean).join(' ')
    : '';

  const header = (
    <PageHeader
      icon="server"
      env={false}
      title={t('envs.title')}
      subtitle={subtitle}
      actions={
        <>
          <Input compact icon="search" fieldClassName="dk-ev-filter" value={q} placeholder={t('envs.filter')} aria-label={t('envs.filter')} onChange={(e) => setQ(e.target.value)} />
          <Button icon="clock" onClick={() => navigate({ view: 'activity' })}>{t('nav.activity')}</Button>
          <Button variant="primary" icon="plus" onClick={openCoreSettings}>{t('envs.add')}</Button>
        </>
      }
    />
  );

  if (!envs && error) return <>{header}<ErrorState error={error} onRetry={() => void envList.refresh()} /></>;
  if (!envs || (loading && !updatedAt)) return <>{header}<div className="dk-ev-grid">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} height={250} style={{ borderRadius: 18 }} />)}</div></>;

  return (
    <>
      {header}
      <div className="dk-ev-grid">
        {visible.map((r) => (
          <EnvCard key={r.key} row={r} sample={samples[r.key]} kindLabel={kindLabel(r.kind)} onRetry={() => { retry(r); void envList.refresh(); }} />
        ))}
        <button type="button" className="dk-ev dk-ev--add" onClick={openCoreSettings}>
          <span className="dk-ev-ic"><Icon name="plus" /></span>
          <b>{t('envs.addCard.title')}</b>
          <span className="dk-ev-addtx">{t('envs.addCard.text')}</span>
          <span className="dk-ev-addtx"><Icon name="externallink" size={13} /> {t('envs.addCard.where')}</span>
        </button>
      </div>
      {visible.length === 0 && <p className="dk-muted">{t('containers.noMatch.title')}</p>}
    </>
  );
}

function EnvCard({ row, sample, kindLabel, onRetry }: { row: Row; sample: Sample | undefined; kindLabel: string; onRetry(): void }) {
  const { env, kind } = row;
  const health: Health = healthOf(kind, env?.status?.reachable ?? true, sample?.answered);
  const off = health === 'off';
  const s = sample?.summary;
  const name = env?.name ?? s?.host ?? t('envs.local');
  const host = env ? s?.host : undefined;
  const sub = [kindLabel, kind === 'local' ? t('envs.localSocket') : host].filter(Boolean).join(', ');
  const limit = limitOf(kind);
  const reason = sample?.error || env?.status?.error || '';
  const note = off ? (reason ? t('envs.note.off', { reason }) : t('envs.note.offNoReason')) : limit ? t(`envs.note.${limit}`) : '';
  const ms = env?.status?.latencyMs;
  const open = () => navigate({ view: 'containers', env: env?.id ?? '' }, { root: true });

  return (
    <div className={`dk-ev hue-${KIND_HUE[kind]}${off ? ' dk-ev--off' : ''}`} data-env={env?.id ?? 'local'} data-health={health}>
      <div className="dk-ev-hd">
        <span className="dk-ev-ic"><Icon name={KIND_ICON[kind]} /></span>
        <div className="dk-ev-t">
          <b title={name}>{name}</b>
          <span className="dk-ev-k" title={sub}>{sub}</span>
        </div>
        <span className={`dk-ev-st dk-ev-st--${health}`}><span className="dk-ev-dot" />{t(`envs.state.${health}`)}</span>
      </div>
      {!off && (
        <>
          <div className="dk-ev-nums">
            <Num n={s?.running} label={t('envs.running')} />
            <Num n={s?.stopped} label={t('envs.stopped')} />
            <Num n={s?.stacks} label={t('envs.stacks')} />
          </div>
          <div className="dk-ev-bars">
            <Bar label={t('envs.cpu')} v={s?.cpu} />
            <Bar label={t('envs.memory')} v={s?.mem} />
          </div>
          {(s?.engine || ms !== undefined) && (
            <div className="dk-ev-meta">{[s?.engine ? t('envs.engine', { version: s.engine }) : '', ms !== undefined ? t('envs.latency', { ms }) : '', s?.partial ? t('envs.partial') : ''].filter(Boolean).join(' · ')}</div>
          )}
        </>
      )}
      {note && <div className={`dk-ev-note${off ? ' dk-ev-note--err' : ''}`} role="note">{note}</div>}
      <div className="dk-ev-go">
        {off ? (
          <>
            <Button icon="refresh" loading={sample?.loading} onClick={onRetry}>{t('envs.retry')}</Button>
            <Button icon="edit" onClick={openCoreSettings}>{t('envs.edit')}</Button>
          </>
        ) : (
          <Button variant="primary" icon="right" onClick={open}>{t('envs.open')}</Button>
        )}
      </div>
    </div>
  );
}

function Num({ n, label }: { n: number | undefined; label: string }) {
  return (
    <div>
      <b>{n === undefined ? '–' : n}</b>
      <span>{label}</span>
    </div>
  );
}

function Bar({ label, v }: { label: string; v: number | null | undefined }) {
  const tone = v !== null && v !== undefined ? (v >= 90 ? ' dk-meter--err' : v >= 75 ? ' dk-meter--warn' : '') : '';
  return (
    <div>
      <span>{label}</span>
      <span className={`dk-meter${tone}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v === null || v === undefined ? undefined : pct(v)}>
        <i style={{ width: `${pct(v)}%` }} />
      </span>
      <span className="dk-mono">{v === null || v === undefined ? '–' : `${pct(v)}%`}</span>
    </div>
  );
}
