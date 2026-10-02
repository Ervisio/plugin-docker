import { info } from '../../api/resources';
import { t } from '../../i18n';
import { Button, Chip, IconButton, Input, Select } from '../../kit';
import { useState } from 'react';
import { CAPS, DEFAULT_CAPS, ULIMITS } from './caps';
import { kv, rid, type GpuMode, type Problems, type Spec } from './model';
import { aria, Hint, removeAt, replaceAt, Section, type StepProps } from './parts';

type Part = 'gpu' | 'devices' | 'caps' | 'sysctls' | 'ulimits';
const PARTS: Part[] = ['gpu', 'devices', 'caps', 'sysctls', 'ulimits'];

/** Resources, GPU, devices, capabilities, sysctls and ulimits. */
export function ResourcesStep({ spec, patch, showErrors, problems }: StepProps & { problems: Problems }) {
  const { data } = info.use();
  const runtimes = data?.info.Runtimes;
  const nvidia = !!runtimes && Object.keys(runtimes).some((r) => r === 'nvidia');
  const [open, setOpen] = useState<Set<Part>>(() => {
    const s = new Set<Part>();
    if (spec.gpu !== 'off') s.add('gpu');
    if (spec.devices.length) s.add('devices');
    if (spec.capAdd.length || spec.capDrop.length) s.add('caps');
    if (spec.sysctls.length) s.add('sysctls');
    if (spec.ulimits.length) s.add('ulimits');
    return s;
  });
  const toggle = (a: Part) => setOpen((s) => { const n = new Set(s); if (n.has(a)) n.delete(a); else n.add(a); return n; });
  const ncpu = data?.info.NCPU;

  return (
    <>
      <Section title={t('create.limits')} note={t('create.optional')}>
        <div className="dk-cr-g2">
          <Input label={t('create.memory')} mono inputMode="decimal" value={spec.memoryMb} onChange={(e) => patch({ memoryMb: e.target.value })} placeholder="512" end={<span className="dk-muted">MB</span>} hint={t('create.limit.hint')} />
          <Input label={t('create.memoryRes')} mono inputMode="decimal" value={spec.memoryReservationMb} onChange={(e) => patch({ memoryReservationMb: e.target.value })} placeholder="256" end={<span className="dk-muted">MB</span>} hint={t('create.memoryRes.hint')} />
          <Input label={t('create.memorySwap')} mono inputMode="decimal" value={spec.memorySwapMb} onChange={(e) => patch({ memorySwapMb: e.target.value })} placeholder={t('create.memorySwap.ph')} end={<span className="dk-muted">MB</span>} hint={t('create.memorySwap.hint')} />
          <Input label={t('create.pids')} mono inputMode="numeric" value={spec.pidsLimit} onChange={(e) => patch({ pidsLimit: e.target.value })} placeholder="200" hint={t('create.pids.hint')} />
          <Input label={t('create.cpus')} mono inputMode="decimal" value={spec.cpus} onChange={(e) => patch({ cpus: e.target.value })} placeholder="1.0" hint={t('create.cpus.hint')} />
          <Input label={t('create.cpuShares')} mono inputMode="numeric" value={spec.cpuShares} onChange={(e) => patch({ cpuShares: e.target.value })} placeholder="1024" hint={t('create.cpuShares.hint')} />
          <Input label={t('create.cpuset')} mono value={spec.cpuset} onChange={(e) => patch({ cpuset: e.target.value })} placeholder="0-1" hint={t('create.cpuset.hint', { n: ncpu ?? '?' })} spellCheck={false} />
          <Input label={t('create.shm')} mono inputMode="decimal" value={spec.shmMb} onChange={(e) => patch({ shmMb: e.target.value })} placeholder="64" end={<span className="dk-muted">MB</span>} hint={t('create.shm.hint')} />
        </div>
        {showErrors && problems.limits && <Hint tone="err" icon="alert">{t(problems.limits)}</Hint>}
        {showErrors && problems.resources && <Hint tone="err" icon="alert">{t(problems.resources)}</Hint>}
        {ncpu && spec.cpus && parseFloat(spec.cpus) > ncpu && <Hint icon="info">{t('create.cpus.more', { n: ncpu })}</Hint>}
      </Section>

      <Section title={t('create.hw')} note={t('create.optional')}>
        <div className="dk-cr-chips" role="group" aria-label={t('create.hw')}>
          {PARTS.map((a) => <Chip key={a} pressed={open.has(a)} onClick={() => toggle(a)}>{t(`create.hw.${a}`)}</Chip>)}
        </div>
        {open.has('gpu') && <GpuPart spec={spec} patch={patch} nvidia={nvidia} known={!!runtimes} />}
        {open.has('devices') && <DevicesPart spec={spec} patch={patch} />}
        {open.has('caps') && <CapsPart spec={spec} patch={patch} />}
        {open.has('sysctls') && (
          <div className="dk-cr-sub">
            <b>{t('create.hw.sysctls')}</b>
            <p className="dk-muted dk-cr-p">{t('create.sysctls.note')}</p>
            {spec.sysctls.map((x, i) => (
              <div className="dk-cr-pr" key={x.id}>
                <Input mono compact value={x.key} placeholder="net.ipv4.ip_forward" aria-label={t('create.env.key')} onChange={(e) => patch({ sysctls: replaceAt(spec.sysctls, i, { key: e.target.value }) })} fieldClassName="dk-cr-fld" spellCheck={false} autoCapitalize="off" />
                <Input mono compact value={x.value} placeholder="1" aria-label={t('create.env.value')} onChange={(e) => patch({ sysctls: replaceAt(spec.sysctls, i, { value: e.target.value }) })} fieldClassName="dk-cr-fld" spellCheck={false} />
                <IconButton icon="trash" label={t('common.remove')} onClick={() => patch({ sysctls: removeAt(spec.sysctls, i) })} />
              </div>
            ))}
            <Button className="dk-cr-add" variant="ghost" size="sm" icon="plus" onClick={() => patch({ sysctls: [...spec.sysctls, kv()] })}>{t('create.sysctl.add')}</Button>
          </div>
        )}
        {open.has('ulimits') && (
          <div className="dk-cr-sub">
            <b>{t('create.hw.ulimits')}</b>
            <p className="dk-muted dk-cr-p">{t('create.ulimits.note')}</p>
            {spec.ulimits.map((u, i) => (
              <div className="dk-cr-pr" key={u.id}>
                <div className="dk-cr-kind"><Select compact value={u.name} onChange={(v) => patch({ ulimits: replaceAt(spec.ulimits, i, { name: v }) })} options={[...new Set([...ULIMITS, u.name])].filter(Boolean).map((n) => ({ value: n, label: n }))} {...aria(t('create.ulimit.name'))} /></div>
                <Input mono compact value={u.soft} placeholder={t('create.ulimit.soft')} aria-label={t('create.ulimit.soft')} onChange={(e) => patch({ ulimits: replaceAt(spec.ulimits, i, { soft: e.target.value }) })} fieldClassName="dk-cr-fld" inputMode="numeric" />
                <Input mono compact value={u.hard} placeholder={t('create.ulimit.hard')} aria-label={t('create.ulimit.hard')} onChange={(e) => patch({ ulimits: replaceAt(spec.ulimits, i, { hard: e.target.value }) })} fieldClassName="dk-cr-fld" inputMode="numeric" />
                <IconButton icon="trash" label={t('common.remove')} onClick={() => patch({ ulimits: removeAt(spec.ulimits, i) })} />
              </div>
            ))}
            <Button className="dk-cr-add" variant="ghost" size="sm" icon="plus" onClick={() => patch({ ulimits: [...spec.ulimits, { id: rid(), name: 'nofile', soft: '1024', hard: '65536' }] })}>{t('create.ulimit.add')}</Button>
          </div>
        )}
      </Section>
    </>
  );
}

function GpuPart({ spec, patch, nvidia, known }: Pick<StepProps, 'spec' | 'patch'> & { nvidia: boolean; known: boolean }) {
  const modes: GpuMode[] = ['off', 'all', 'count', 'ids'];
  return (
    <div className="dk-cr-sub">
      <b>{t('create.hw.gpu')}</b>
      <div className="dk-cr-g2">
        <Select label={t('create.gpu.mode')} value={spec.gpu} onChange={(v) => patch({ gpu: v as GpuMode })} options={modes.map((m) => ({ value: m, label: t(`create.gpu.${m}`) }))} />
        {spec.gpu === 'count' && <Input label={t('create.gpu.count')} mono inputMode="numeric" value={spec.gpuCount} onChange={(e) => patch({ gpuCount: e.target.value })} placeholder="1" />}
        {spec.gpu === 'ids' && <Input label={t('create.gpu.ids')} mono value={spec.gpuIds} onChange={(e) => patch({ gpuIds: e.target.value })} placeholder="0, GPU-3a23c669-…" hint={t('create.gpu.idsHint')} spellCheck={false} />}
      </div>
      {spec.gpu !== 'off' && known && !nvidia && <Hint tone="warn" icon="alert">{t('create.gpu.missing')}</Hint>}
      {spec.gpu !== 'off' && nvidia && <Hint tone="ok" icon="check">{t('create.gpu.found')}</Hint>}
      {spec.gpu === 'off' && <p className="dk-muted dk-cr-p">{known && !nvidia ? t('create.gpu.missingNote') : t('create.gpu.note')}</p>}
    </div>
  );
}

const PERMS = ['rwm', 'rw', 'r', 'w', 'm', 'rm', 'wm'];

function DevicesPart({ spec, patch }: Pick<StepProps, 'spec' | 'patch'>) {
  return (
    <div className="dk-cr-sub">
      <b>{t('create.hw.devices')}</b>
      <p className="dk-muted dk-cr-p">{t('create.devices.note')}</p>
      {spec.devices.map((d, i) => (
        <div className="dk-cr-pr dk-cr-mount" key={d.id}>
          <Input mono compact value={d.host} placeholder="/dev/ttyUSB0" aria-label={t('create.device.host')} onChange={(e) => patch({ devices: replaceAt(spec.devices, i, { host: e.target.value }) })} fieldClassName="dk-cr-fld" spellCheck={false} />
          <Input mono compact value={d.container} placeholder={d.host || '/dev/ttyUSB0'} aria-label={t('create.device.container')} onChange={(e) => patch({ devices: replaceAt(spec.devices, i, { container: e.target.value }) })} fieldClassName="dk-cr-fld" spellCheck={false} />
          <div className="dk-cr-kind"><Select compact value={d.perms} onChange={(v) => patch({ devices: replaceAt(spec.devices, i, { perms: v }) })} options={[...new Set([...PERMS, d.perms])].map((p) => ({ value: p, label: p }))} {...aria(t('create.device.perms'))} /></div>
          <IconButton icon="trash" label={t('common.remove')} onClick={() => patch({ devices: removeAt(spec.devices, i) })} />
        </div>
      ))}
      <Button className="dk-cr-add" variant="ghost" size="sm" icon="plus" onClick={() => patch({ devices: [...spec.devices, { id: rid(), host: '', container: '', perms: 'rwm' }] })}>{t('create.device.add')}</Button>
    </div>
  );
}

function CapsPart({ spec, patch }: Pick<StepProps, 'spec' | 'patch'>) {
  const label = (c: string) => (DEFAULT_CAPS.includes(c) ? `${c} (${t('create.cap.default')})` : c);
  const picker = (kind: 'capAdd' | 'capDrop', title: string, note: string, options: readonly string[]) => {
    const list = spec[kind];
    const free = options.filter((c) => !spec.capAdd.includes(c) && !spec.capDrop.includes(c));
    return (
      <div className="dk-cr-capcol">
        <b>{title}</b>
        <p className="dk-muted dk-cr-p">{note}</p>
        <div className="dk-cr-chips">
          {list.map((c) => (
            <button key={c} type="button" className="dk-cr-cap" onClick={() => patch({ [kind]: list.filter((x) => x !== c) } as Partial<Spec>)} title={t('common.remove')}>
              <span className="dk-mono">{c}</span><span aria-hidden>×</span><span className="dk-c-sr">{t('common.remove')}</span>
            </button>
          ))}
        </div>
        <Select compact value="" onChange={(v) => v && patch({ [kind]: [...list, v] } as Partial<Spec>)} options={[{ value: '', label: t('create.cap.pick') }, ...free.map((c) => ({ value: c, label: label(c) }))]} {...aria(title)} />
      </div>
    );
  };
  return (
    <div className="dk-cr-sub">
      <b>{t('create.hw.caps')}</b>
      <div className="dk-cr-g2">
        {picker('capAdd', t('create.cap.add'), t('create.cap.addNote'), CAPS.filter((c) => !DEFAULT_CAPS.includes(c)))}
        {picker('capDrop', t('create.cap.drop'), t('create.cap.dropNote'), ['ALL', ...CAPS])}
      </div>
    </div>
  );
}
