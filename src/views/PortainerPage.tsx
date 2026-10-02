import { useCallback, useEffect, useMemo, useState } from 'react';
import { docker, errorText } from '../api/engine';
import { listStacks, type Stack } from '../api/compose';
import { copyTextSafe } from './resources/copy';
import {
  environmentChecklist, findPortainer, importRegistries, importStack, importTemplate, loadPortainerData, planStack, stackVerdict, templateVerdict,
  PortainerDbError, type PortainerContainer, type StackPlan, type StackResult,
} from '../api/portainer';
import type { PortainerData, PRegistry, PStack, PTemplate } from '../api/portainerDb';
import { repoLabel } from '../api/gitMeta';
import { customTemplates, reloadCustom } from '../api/customTemplates';
import type { Container } from '../api/types';
import { t, tn } from '../i18n';
import { Badge, Button, Card, Checkbox, Dialog, EmptyState, Icon, Skeleton, toast } from '../kit';
import { currentEnv } from '../api/environments';
import { useEnv } from '../api/useEnv';
import { PageHeader } from '../ui/PageHeader';
import { ErrorState } from '../ui/ErrorState';
import { classify } from '../api/engine';
import { MovePreview } from './stack/MovePreview';

type Phase =
  | { kind: 'scanning' }
  | { kind: 'none' }
  | { kind: 'pick'; list: PortainerContainer[] }
  | { kind: 'reading'; c: PortainerContainer }
  | { kind: 'error'; c: PortainerContainer; code: PortainerDbError['code'] | 'other'; message: string }
  | { kind: 'ready'; c: PortainerContainer; data: PortainerData };

/** Route { view: 'portainer' }: Tools › Import from Portainer. */
export function PortainerPage() {
  const { info } = useEnv();
  if (currentEnv()) return <PortainerElsewhere name={info?.name ?? ''} />;
  return <PortainerHere />;
}

function PortainerElsewhere({ name }: { name: string }) {
  return (
    <>
      <PageHeader icon="download" hue="svc" title={t('pt.title')} subtitle={t('pt.sub')} />
      <EmptyState icon="info" title={t('envs.jobs.title')} text={t('envs.portainer.text', { env: name })} />
    </>
  );
}

function PortainerHere() {
  const [phase, setPhase] = useState<Phase>({ kind: 'scanning' });
  const [scanErr, setScanErr] = useState<ReturnType<typeof classify> | null>(null);

  const read = useCallback(async (c: PortainerContainer) => {
    setPhase({ kind: 'reading', c });
    try {
      setPhase({ kind: 'ready', c, data: await loadPortainerData(c) });
    } catch (e) {
      setPhase({ kind: 'error', c, code: e instanceof PortainerDbError ? e.code : 'other', message: (e as Error).message });
    }
  }, []);

  const scan = useCallback(async () => {
    setPhase({ kind: 'scanning' });
    setScanErr(null);
    try {
      const list = await findPortainer();
      if (!list.length) setPhase({ kind: 'none' });
      else if (list.length === 1) await read(list[0]);
      else setPhase({ kind: 'pick', list });
    } catch (e) {
      setScanErr(classify(e));
    }
  }, [read]);
  useEffect(() => { void scan(); }, [scan]);

  const header = <PageHeader icon="download" hue="svc" title={t('pt.title')} subtitle={t('pt.sub')} actions={<Button icon="refresh" onClick={() => void scan()}>{t('common.refresh')}</Button>} />;

  if (scanErr) return <>{header}<ErrorState error={scanErr} onRetry={() => void scan()} /></>;
  switch (phase.kind) {
    case 'scanning':
      return <>{header}<Skeleton height={120} style={{ borderRadius: 18 }} /></>;
    case 'none':
      return <>{header}<EmptyState icon="search" hue="svc" title={t('pt.none.title')} text={t('pt.none.text')} action={<Button onClick={() => void scan()}>{t('common.retry')}</Button>} /></>;
    case 'pick':
      return (
        <>
          {header}
          <Card title={t('pt.pick')}>
            <p className="dk-muted">{t('pt.pick.text')}</p>
            {phase.list.map((c) => (
              <div key={c.id} className="dk-pt-item">
                <div className="dk-pt-head">
                  <div className="dk-pt-tx"><b>{c.name}</b><span className="dk-muted">{c.image} · {c.state}</span></div>
                  <Button size="sm" variant="primary" onClick={() => void read(c)}>{t('pt.pick.use')}</Button>
                </div>
              </div>
            ))}
          </Card>
        </>
      );
    case 'reading':
      return <>{header}<Card><p className="dk-muted"><span className="dk-sk-spin" aria-hidden="true" /> {t('pt.reading', { name: phase.c.name })}</p></Card></>;
    case 'error':
      return (
        <>
          {header}
          <EmptyState
            icon="alert"
            hue="svc"
            title={t(`pt.err.${phase.code}.title`)}
            text={<>{t(`pt.err.${phase.code}.text`, { name: phase.c.name })}{phase.code === 'other' || phase.code === 'unreadable' ? <><br /><code>{phase.message}</code></> : null}</>}
            action={<Button onClick={() => void read(phase.c)}>{t('common.retry')}</Button>}
          />
        </>
      );
    case 'ready':
      return <>{header}<Ready c={phase.c} data={phase.data} /></>;
  }
}

/* ---------- the data ---------- */

function Ready({ c, data }: { c: PortainerContainer; data: PortainerData }) {
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [all, setAll] = useState<Container[]>([]);
  const [selS, setSelS] = useState<Set<number>>(new Set());
  const [selR, setSelR] = useState<Set<number>>(new Set());
  const [selT, setSelT] = useState<Set<number>>(new Set());
  const [ask, setAsk] = useState(false);
  const [results, setResults] = useState<{ group: string; r: StackResult }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    const [s, cs] = await Promise.all([listStacks().catch(() => [] as Stack[]), docker.get<Container[]>('/containers/json', { all: '1' }).catch(() => [] as Container[])]);
    setStacks(s);
    setAll(cs);
    await reloadCustom();
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const taken = useMemo(() => new Set(stacks.filter((s) => s.managed).map((s) => s.name)), [stacks]);
  const local = useMemo(() => new Set(data.endpoints.filter((e) => e.maps === 'this-machine').map((e) => e.id)), [data]);
  const verdict = (s: PStack) => stackVerdict(s, taken, local);
  const importable = data.stacks.filter((s) => verdict(s).ok);
  const gitLogins = data.stacks.filter((s) => selS.has(s.id) && s.git?.password).length;
  const regLogins = data.registries.filter((r) => selR.has(r.id) && r.password).length;

  const toggle = (set: Set<number>, id: number, on: boolean, fn: (s: Set<number>) => void) => {
    const n = new Set(set);
    if (on) n.add(id);
    else n.delete(id);
    fn(n);
  };

  const run = async (withLogins: boolean) => {
    setAsk(false);
    setBusy(true);
    setLog([]);
    const out: { group: string; r: StackResult }[] = [];
    const say = (l: string) => setLog((x) => [...x.slice(-200), l]);
    try {
      for (const s of data.stacks.filter((x) => selS.has(x.id))) {
        const r = await importStack(c, s, all, { withLogin: withLogins }, say);
        out.push({ group: 'stack', r });
      }
      const regs = data.registries.filter((x) => selR.has(x.id));
      if (regs.length) {
        const rr = await importRegistries(regs, withLogins ? new Set(regs.map((x) => x.id)) : new Set());
        rr.forEach((r) => out.push({ group: 'registry', r }));
      }
      for (const tpl of data.templates.filter((x) => selT.has(x.id))) out.push({ group: 'template', r: await importTemplate(c, tpl) });
    } catch (e) {
      toast.err(t('pt.import.fail'), errorText(e));
    }
    setResults(out);
    setBusy(false);
    setSelS(new Set());
    setSelR(new Set());
    setSelT(new Set());
    await refresh();
  };

  const start = () => {
    if (gitLogins + regLogins > 0) setAsk(true);
    else void run(false);
  };
  const total = selS.size + selR.size + selT.size;

  return (
    <div className="dk-pt">
      <div className="dk-sk-note">
        <Icon name="info" />
        <div>
          <b>{t('pt.found', { name: c.name, version: data.version || '?' })}</b>
          <p>{c.state !== 'running' ? t('pt.stopped') + ' ' : ''}{t('pt.found.text')}</p>
        </div>
      </div>

      <Section title={t('pt.stacks')} count={`${data.stacks.length}`} empty={t('pt.stacks.none')} show={data.stacks.length > 0}
        action={importable.length > 0 && <Button size="sm" variant="ghost" onClick={() => setSelS(new Set(importable.map((s) => s.id)))}>{t('pt.selectAll')}</Button>}>
        {data.stacks.map((s) => (
          <StackRow key={s.id} s={s} verdict={verdict(s)} checked={selS.has(s.id)} onCheck={(on) => toggle(selS, s.id, on, setSelS)} c={c} all={all} endpoints={data.endpoints} />
        ))}
      </Section>

      <Section title={t('pt.registries')} count={`${data.registries.length}`} empty={t('pt.registries.none')} show={data.registries.length > 0}
        action={data.registries.length > 0 && <Button size="sm" variant="ghost" onClick={() => setSelR(new Set(data.registries.filter((r) => !r.unsupported).map((r) => r.id)))}>{t('pt.selectAll')}</Button>}>
        {data.registries.map((r) => <RegistryRow key={r.id} r={r} checked={selR.has(r.id)} onCheck={(on) => toggle(selR, r.id, on, setSelR)} />)}
      </Section>

      <Section title={t('pt.templates')} count={`${data.templates.length}`} empty={t('pt.templates.none')} show={data.templates.length > 0}
        action={data.templates.length > 0 && <Button size="sm" variant="ghost" onClick={() => setSelT(new Set(data.templates.filter((x) => templateVerdict(x).ok).map((x) => x.id)))}>{t('pt.selectAll')}</Button>}>
        {data.templates.map((x) => <TemplateRow key={x.id} tpl={x} checked={selT.has(x.id)} onCheck={(on) => toggle(selT, x.id, on, setSelT)} exists={customTemplates().some((y) => y.name === x.title)} />)}
      </Section>

      <Environments data={data} />

      <div className="dk-pt-bar">
        <span className="dk-muted">{t('pt.selected', { n: total })}</span>
        <Button variant="primary" icon="download" loading={busy} disabled={!total || busy} onClick={start}>{t('pt.import')}</Button>
      </div>

      {busy && log.length > 0 && <pre className="dk-jb-code" aria-live="polite">{log.slice(-12).join('\n')}</pre>}
      {results && <Results results={results} />}

      <Dialog
        open={ask}
        onClose={() => setAsk(false)}
        title={t('pt.ask.title')}
        description={t('pt.ask.text', { git: gitLogins, reg: regLogins })}
        icon="key"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsk(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void run(false)}>{t('pt.ask.without')}</Button>
            <Button variant="primary" onClick={() => void run(true)}>{t('pt.ask.with')}</Button>
          </>
        }
      >
        <p className="dk-muted">{t('pt.ask.where')}</p>
      </Dialog>
    </div>
  );
}

function Section({ title, count, children, empty, show, action }: { title: string; count: string; children: React.ReactNode; empty: string; show: boolean; action?: React.ReactNode }) {
  return (
    <Card title={`${title} · ${count}`} action={action || undefined}>
      {show ? <div className="dk-pt-list">{children}</div> : <p className="dk-muted">{empty}</p>}
    </Card>
  );
}

function StackRow({ s, verdict, checked, onCheck, c, all, endpoints }: { s: PStack; verdict: ReturnType<typeof stackVerdict>; checked: boolean; onCheck(on: boolean): void; c: PortainerContainer; all: Container[]; endpoints: PortainerData['endpoints'] }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<StackPlan | null>(null);
  useEffect(() => {
    if (open && !plan && !s.git) void planStack(c, s, all).then(setPlan);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = all.filter((x) => x.Labels?.['com.docker.compose.project'] === s.name && x.State === 'running').length;
  const env = endpoints.find((e) => e.id === s.endpointId);
  return (
    <div className={`dk-pt-item${verdict.ok ? '' : ' dk-pt-item--off'}`}>
      <div className="dk-pt-head">
        <Checkbox checked={checked} disabled={!verdict.ok} onChange={onCheck} aria-label={s.name} />
        <div className="dk-pt-tx">
          <b>{s.name}</b>
          <span className="dk-muted">
            {s.git ? `${repoLabel(s.git.url)} · ${s.git.ref} · ${s.git.file}` : s.entryPoint}
            {s.env.length ? ` · ${tn('pt.vars', { n: s.env.length })}` : ''}
            {running ? ` · ${t('pt.running', { n: running })}` : ''}
          </span>
        </div>
        <Badge tone={s.git ? 'neutral' : 'info'}>{s.git ? 'Git' : s.kind === 'compose' ? 'Compose' : s.kind === 'swarm' ? 'Swarm' : 'Kubernetes'}</Badge>
        {!verdict.ok && <Badge tone="warn">{t(`pt.why.${verdict.reason}`, { env: env?.name ?? String(s.endpointId) })}</Badge>}
        {verdict.ok && <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>{t(open ? 'pt.hide' : 'pt.details')}</Button>}
      </div>
      {open && (
        <div className="dk-pt-more">
          {s.git ? (
            <ul>
              <li>{t('pt.git.clone', { url: s.git.url, ref: s.git.ref })}</li>
              <li>{s.git.password ? t('pt.git.login', { user: s.git.username ?? '' }) : t('pt.git.public')}</li>
              {s.autoUpdateSeconds && <li>{t('pt.git.auto', { m: Math.round(s.autoUpdateSeconds / 60) })}</li>}
              {s.hadWebhook && <li>{t('pt.git.webhook')}</li>}
              {s.env.length > 0 && <li>{tn('pt.git.env', { n: s.env.length })}</li>}
            </ul>
          ) : !plan ? <Skeleton height={60} /> : plan.move && plan.origin ? <MovePreview plan={plan.move} dir={`/opt/stacks/${s.name}`} fromPortainer /> : <p className="dk-sk-err">{plan.problem}</p>}
        </div>
      )}
    </div>
  );
}

function RegistryRow({ r, checked, onCheck }: { r: PRegistry; checked: boolean; onCheck(on: boolean): void }) {
  return (
    <div className={`dk-pt-item${r.unsupported ? ' dk-pt-item--off' : ''}`}>
      <div className="dk-pt-head">
        <Checkbox checked={checked} disabled={!!r.unsupported} onChange={onCheck} aria-label={r.name} />
        <div className="dk-pt-tx"><b>{r.name}</b><span className="dk-muted">{r.server || '–'}{r.username ? ` · ${r.username}` : ''}</span></div>
        <Badge tone="neutral">{r.kind}</Badge>
        {r.password && <Badge tone="warn">{t('pt.reg.hasPassword')}</Badge>}
        {r.unsupported && <span className="dk-muted">{r.unsupported}</span>}
      </div>
    </div>
  );
}

function TemplateRow({ tpl, checked, onCheck, exists }: { tpl: PTemplate; checked: boolean; onCheck(on: boolean): void; exists: boolean }) {
  const v = templateVerdict(tpl);
  return (
    <div className={`dk-pt-item${v.ok ? '' : ' dk-pt-item--off'}`}>
      <div className="dk-pt-head">
        <Checkbox checked={checked} disabled={!v.ok} onChange={onCheck} aria-label={tpl.title} />
        <div className="dk-pt-tx"><b>{tpl.title}</b><span className="dk-muted">{tpl.description || '–'}{tpl.variables.length ? ` · ${tn('pt.vars', { n: tpl.variables.length })}` : ''}</span></div>
        {!v.ok && <Badge tone="warn">{t(`pt.twhy.${v.reason}`)}</Badge>}
        {v.ok && exists && <Badge tone="neutral">{t('pt.tpl.exists')}</Badge>}
      </div>
    </div>
  );
}

function Environments({ data }: { data: PortainerData }) {
  const list = data.endpoints;
  const text = environmentChecklist(data);
  return (
    <Card title={`${t('pt.envs')} · ${list.length}`} action={<Button size="sm" variant="ghost" icon="copy" onClick={() => void copyTextSafe(text)}>{t('pt.envs.copy')}</Button>}>
      <p className="dk-muted dk-jb-p">{t('pt.envs.text')}</p>
      <div className="dk-pt-list">
        {list.map((e) => (
          <div key={e.id} className="dk-pt-item">
            <div className="dk-pt-head">
              <div className="dk-pt-tx">
                <b>{e.name}</b>
                <span className="dk-muted">{e.url}{e.publicUrl ? ` · ${e.publicUrl}` : ''}{e.tls ? ' · TLS' : ''}</span>
                {e.note && <span className="dk-muted">{e.note}</span>}
              </div>
              <Badge tone={e.maps === 'none' ? 'warn' : e.maps === 'this-machine' ? 'ok' : 'info'}>{t(`pt.env.${e.maps}`)}</Badge>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Results({ results }: { results: { group: string; r: StackResult }[] }) {
  const done = results.filter((x) => x.r.status === 'done').length;
  return (
    <Card title={t('pt.results', { done, total: results.length })}>
      <div className="dk-pt-list">
        {results.map((x, i) => (
          <div key={i} className="dk-pt-item">
            <div className="dk-pt-head">
              <span className={`dk-dot dk-dot--${x.r.status === 'done' ? 'ok' : x.r.status === 'skipped' ? 'warn' : 'err'}`} />
              <div className="dk-pt-tx"><b>{x.r.name}</b>{x.r.note && <span className="dk-muted">{x.r.note}</span>}</div>
              <Badge tone="neutral">{t(`pt.group.${x.group}`)}</Badge>
              <Badge tone={x.r.status === 'done' ? 'ok' : x.r.status === 'skipped' ? 'warn' : 'err'}>{t(`pt.status.${x.r.status}`)}</Badge>
            </div>
          </div>
        ))}
      </div>
      <p className="dk-muted">{t('pt.results.next')}</p>
    </Card>
  );
}

