import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ACTIONS, EMPTY_FILTER, envLabel, matchesEnv, serverQuery, toCsv, type ActivityFilter } from '../api/activity';
import { envList } from '../api/envList';
import { errorText } from '../api/engine';
import { DataTable, type DataColumn } from '../ui/DataTable';
import { t, tn } from '../i18n';
import { Badge, Button, EmptyState, Input, Select, Skeleton, toast } from '../kit';
import { getSdk, type AuditEntry } from '../sdk';
import { PageHeader } from '../ui/PageHeader';

const PAGE = 200;

const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(getSdk().lang(), { dateStyle: 'short', timeStyle: 'medium' });
};

const TONE: Record<string, 'ok' | 'warn' | 'err'> = { ok: 'ok', failed: 'warn', denied: 'err', error: 'err' };

/** Route { view: 'activity' }: what was done through this plugin, on which host, by whom (sdk.audit.list). */
export function ActivityPage() {
  const { data: envs } = envList.use();
  const [filter, setFilter] = useState<ActivityFilter>(EMPTY_FILTER);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);

  const names = useMemo(() => new Map((envs ?? []).map((e) => [e.id, e.name])), [envs]);
  const local = t('envs.local');

  const load = useCallback(async (f: ActivityFilter, cursor?: string) => {
    const mine = ++seq.current;
    if (cursor) setMore(true);
    else setLoading(true);
    try {
      const r = await getSdk().audit.list({ ...serverQuery(f), limit: PAGE, ...(cursor ? { cursor } : {}) });
      if (mine !== seq.current) return;
      setEntries((prev) => (cursor ? [...prev, ...r.entries] : r.entries));
      setNext(r.next);
      setEnabled(r.enabled);
      setError('');
    } catch (e) {
      if (mine === seq.current) setError(errorText(e));
    } finally {
      if (mine === seq.current) {
        setLoading(false);
        setMore(false);
      }
    }
  }, []);

  // Filters the daemon applies reload the log; a typed user name waits for a pause.
  const key = JSON.stringify(serverQuery(filter));
  useEffect(() => {
    const id = setTimeout(() => void load(filter), filter.user ? 350 : 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load]);

  const rows = useMemo(() => entries.filter((e) => matchesEnv(e, filter.env)), [entries, filter.env]);
  const set = (patch: Partial<ActivityFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const filtered = JSON.stringify(filter) !== JSON.stringify(EMPTY_FILTER);

  const exportCsv = async () => {
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      await getSdk().saveFile(`docker-activity-${stamp}.csv`, toCsv(rows, names, local), 'text/csv');
    } catch (e) {
      toast.err(t('activity.exportFail'), errorText(e));
    }
  };

  const envOptions = [
    { value: '', label: t('activity.env.all') },
    { value: 'local', label: local },
    ...(envs ?? []).map((e) => ({ value: e.id, label: e.name })),
    // An environment that was removed still has entries: offer the ones the log mentions.
    ...[...new Set(entries.map((e) => e.env).filter((id): id is string => !!id && !names.has(id)))].map((id) => ({ value: id, label: id })),
  ];

  const columns: DataColumn<AuditEntry>[] = [
    { key: 'time', header: t('activity.col.time'), render: (e) => <span className="dk-mono">{fmtTime(e.time)}</span>, className: 'dk-nowrap' },
    { key: 'user', header: t('activity.col.user'), render: (e) => <>{e.user}{e.origin ? <span className="dk-muted dk-act-origin"> {e.origin}</span> : null}</> },
    { key: 'action', header: t('activity.col.action'), render: (e) => <span className="dk-tag">{e.action}</span> },
    { key: 'target', header: t('activity.col.target'), render: (e) => <span className="dk-mono dk-act-target" title={e.detail ? `${e.target ?? ''}\n${e.detail}` : e.target}>{e.target ?? ''}</span> },
    { key: 'env', header: t('activity.col.env'), render: (e) => <span className={`dk-act-env${e.env ? '' : ' dk-act-env--local'}`}>{envLabel(e, names, local)}</span>, hideBelow: 'sm' },
    { key: 'result', header: t('activity.col.result'), render: (e) => <Badge tone={TONE[e.result] ?? 'neutral'}>{t(`activity.result.${e.result}`)}{e.code !== undefined && e.result !== 'ok' ? ` ${e.code}` : ''}</Badge> },
  ];

  const header = (
    <PageHeader
      icon="clock"
      env={false}
      title={t('activity.title')}
      subtitle={loading && !entries.length ? '' : tn('activity.sub', { n: rows.length })}
      actions={<Button icon="download" disabled={!rows.length} onClick={() => void exportCsv()}>{t('activity.export')}</Button>}
    />
  );

  return (
    <>
      {header}
      {!enabled && <div className="dk-ev-where dk-ev-where--warn" role="note">{t('activity.off')}</div>}
      <div className="dk-act-filters">
        <Select label={t('activity.f.env')} options={envOptions} value={filter.env} onChange={(v) => set({ env: v })} />
        <Input label={t('activity.f.user')} value={filter.user} placeholder={t('activity.f.userAny')} onChange={(e) => set({ user: e.target.value })} />
        <Select label={t('activity.f.action')} options={[{ value: '', label: t('activity.action.all') }, ...ACTIONS.map((a) => ({ value: a, label: a }))]} value={filter.action} onChange={(v) => set({ action: v })} />
        <Input label={t('activity.f.from')} type="date" value={filter.from} max={filter.to || undefined} onChange={(e) => set({ from: e.target.value })} />
        <Input label={t('activity.f.to')} type="date" value={filter.to} min={filter.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        {filtered && <Button variant="ghost" onClick={() => setFilter(EMPTY_FILTER)}>{t('activity.clear')}</Button>}
      </div>
      {error ? (
        <EmptyState icon="alert" hue="svc" title={t('activity.err')} text={error} action={<Button icon="refresh" onClick={() => void load(filter)}>{t('common.retry')}</Button>} />
      ) : loading && !entries.length ? (
        <Skeleton height={240} style={{ borderRadius: 18 }} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(e) => `${e.time}|${e.user}|${e.action}|${e.target ?? ''}|${e.env ?? ''}`}
            empty={<EmptyState icon="clock" hue="log" title={t(filtered ? 'activity.noMatch.title' : 'activity.empty.title')} text={t(filtered ? 'activity.noMatch.text' : 'activity.empty.text')} />}
          />
          {next && <div className="dk-act-more"><Button loading={more} onClick={() => void load(filter, next)}>{t('activity.more')}</Button><span className="dk-muted">{t('activity.moreHint', { n: entries.length })}</span></div>}
        </>
      )}
    </>
  );
}
