import { t } from '../../i18n';
import { Switch } from '../../kit';
import { Hint, Section, type StepProps } from './parts';
import { runText, NO_PORTS_MODES, type Spec } from './model';

export function ReviewStep({ spec, patch, recreate }: StepProps & { recreate: boolean }) {
  return (
    <>
      <Section title={t('create.review.run')} note={t('create.review.runNote')}>
        <pre className="dk-cr-run">{runText(spec)}</pre>
      </Section>
      <Section title={t('create.review.options')}>
        <Switch checked={spec.start} onChange={(v) => patch({ start: v })} label={t('create.review.start')} />
        {recreate && <Hint icon="info">{t('create.review.recreate')}</Hint>}
        {spec.privileged && <Hint tone="warn" icon="alert">{t('create.privileged.warn')}</Hint>}
      </Section>
    </>
  );
}

/** The card on the right: what the container will be so far. */
export function Summary({ spec, title }: { spec: Spec; title: string }) {
  const ports = NO_PORTS_MODES(spec.network) ? [] : spec.ports.filter((p) => p.container.trim());
  const folders = spec.mounts.filter((m) => m.kind === 'bind' && m.source.trim()).length;
  const vols = spec.mounts.filter((m) => m.kind === 'volume' && m.source.trim()).length;
  const limits = [
    spec.memoryMb.trim() && `${spec.memoryMb.trim()} MB`,
    spec.memoryReservationMb.trim() && `${t('create.sum.reserve', { n: spec.memoryReservationMb.trim() })}`,
    spec.memorySwapMb.trim() && `${t('create.sum.swap', { n: spec.memorySwapMb.trim() === '-1' ? '∞' : `${spec.memorySwapMb.trim()} MB` })}`,
    spec.cpus.trim() && `${spec.cpus.trim()} CPU`,
    spec.cpuShares.trim() && `${spec.cpuShares.trim()} ${t('create.sum.shares')}`,
    spec.cpuset.trim() && `${t('create.sum.cores')} ${spec.cpuset.trim()}`,
    spec.pidsLimit.trim() && `${spec.pidsLimit.trim()} ${t('create.sum.pids')}`,
    spec.shmMb.trim() && `${t('create.sum.shm')} ${spec.shmMb.trim()} MB`,
  ].filter(Boolean).join(', ');
  const gpu = spec.gpu === 'all' ? t('create.sum.gpu.all') : spec.gpu === 'count' ? t(spec.gpuCount.trim() === '1' ? 'create.sum.gpu.count' : 'create.sum.gpu.countn', { n: spec.gpuCount.trim() || '1' }) : spec.gpu === 'ids' ? t('create.sum.gpu.ids', { ids: spec.gpuIds.split(/[\s,]+/).filter(Boolean).join(', ') }) : '';
  const caps = [spec.capAdd.length && `+${spec.capAdd.join(', +')}`, spec.capDrop.length && `-${spec.capDrop.join(', -')}`].filter(Boolean).join(' ');
  const devices = spec.devices.filter((d) => d.host.trim()).map((d) => d.host.trim()).join(', ');
  const sysctls = spec.sysctls.filter((x) => x.key.trim()).map((x) => `${x.key.trim()}=${x.value}`).join(', ');
  const ulimits = spec.ulimits.filter((u) => u.name.trim()).map((u) => `${u.name.trim()} ${u.soft.trim()}:${u.hard.trim()}`).join(', ');
  const console_ = [spec.openStdin && 'stdin', spec.tty && 'tty'].filter(Boolean).join(' + ');
  const storage = [folders && t(folders === 1 ? 'create.sum.folder' : 'create.sum.folders', { n: folders }), vols && t(vols === 1 ? 'create.sum.volume' : 'create.sum.volumes', { n: vols })].filter(Boolean).join(', ');
  const row = (k: string, v: string | undefined, mono?: boolean) =>
    v ? (
      <>
        <dt>{k}</dt>
        <dd className={mono ? 'dk-mono' : undefined}>{v}</dd>
      </>
    ) : null;
  return (
    <section className="dk-cr-card">
      <h3>{title}</h3>
      <dl className="dk-cr-kv">
        {row(t('create.image'), spec.image.trim() || '–', true)}
        {row(t('create.name'), spec.name.trim() || t('create.sum.autoName'))}
        {row(t('create.restart'), t(`create.restart.${spec.restart}`))}
        {row(t('create.ports'), ports.map((p) => `${p.host.trim() || t('create.port.random')} → ${p.container.trim()}${p.proto === 'udp' ? '/udp' : ''}`).join(', '), true)}
        {row(t('create.storage'), storage)}
        {row(t('create.env'), spec.env.filter((e) => e.key.trim()).length ? t(spec.env.filter((e) => e.key.trim()).length === 1 ? 'create.sum.var' : 'create.sum.vars', { n: spec.env.filter((e) => e.key.trim()).length }) : '')}
        {row(t('create.network'), spec.network === 'bridge' ? t('create.net.bridge') : spec.network)}
        {row(t('create.limits'), limits)}
        {row(t('create.sum.gpu'), gpu)}
        {row(t('create.sum.devices'), devices, true)}
        {row(t('create.sum.caps'), caps, true)}
        {row(t('create.sum.sysctls'), sysctls, true)}
        {row(t('create.sum.ulimits'), ulimits, true)}
        {row(t('create.sum.console'), console_)}
        {row(t('create.sum.init'), spec.init ? t('common.yes') : '')}
        {row(t('create.adv.privileged'), spec.privileged ? t('common.yes') : '')}
      </dl>
    </section>
  );
}
