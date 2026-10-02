import { useEffect, useMemo, useRef, useState } from 'react';
import { docker, errorText } from '../api/engine';
import { formatBytes } from '../api/format';
import { containers, diskUsage, volumes } from '../api/resources';
import { createHelper, emptyVolume, isHelper, lifetimeFor, removeContainer, restoreRoot, sendRestore, startBackup, sweepHelpers, VOLUME_ROOT, type Helper } from '../api/volumes';
import type { Container, VolumeInfo } from '../api/types';
import { containerName } from '../api/format';
import { t, tn } from '../i18n';
import { Button, Checkbox, ConfirmDialog, EmptyState, Icon, Progress, toast } from '../kit';
import { ErrorState } from '../ui/ErrorState';
import { PageHeader } from '../ui/PageHeader';
import { FilesTab } from './container/FilesTab';
import { Hint } from './create/parts';
import { jobsHere } from '../api/jobs';
import { BackupSchedules } from './jobs/BackupSchedules';
import { isAnonymousVolume, UsedBy } from './resources/bits';
import { useHelperImage } from './volume/useHelperImage';

/**
 * One volume: browse its files, download a backup, restore a backup. All three use a short-lived helper container (see
 * api/volumes.ts), created only when the user asks and removed as soon as the work is done.
 */
export function VolumePage({ name, focus }: { name: string; focus?: 'backup' | 'restore' | 'schedule' }) {
  const vols = volumes.use();
  const cts = containers.use().data ?? [];
  const df = diskUsage.use().data;
  const vol: VolumeInfo | undefined = vols.data?.find((v) => v.Name === name);
  const users = useMemo(() => cts.filter((c) => !isHelper(c) && (c.Mounts ?? []).some((m) => m.Type === 'volume' && m.Name === name)), [cts, name]);
  const size = df?.Volumes?.find((v) => v.Name === name)?.UsageData?.Size ?? -1;
  const image = useHelperImage();
  /** Helpers this page made and still needs: the sweep leaves them alone. */
  const mine = useRef(new Set<string>());

  useEffect(() => {
    void sweepHelpers(mine.current).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!focus || !vol) return;
    document.getElementById(`dk-vol-${focus}`)?.scrollIntoView({ block: 'start' });
  }, [focus, !!vol]);
  useEffect(() => () => mine.current.forEach((id) => void removeContainer(id).catch(() => undefined)), []);

  if (!vol && vols.error) return <><PageHeader icon="database" hue="term" title={name} back /><ErrorState error={vols.error} onRetry={() => void volumes.refresh()} /></>;
  if (!vol && !vols.loading) return <><PageHeader icon="database" hue="term" title={name} back /><EmptyState icon="database" hue="term" title={t('volume.gone.title')} text={t('volume.gone.text')} /></>;

  const track = (h: Helper): Helper => {
    mine.current.add(h.id);
    return { ...h, remove: async () => { mine.current.delete(h.id); await h.remove(); } };
  };
  const subtitle = [vol?.Driver, size >= 0 ? formatBytes(size) : undefined, tn('volume.usedBy', { n: users.length })].filter(Boolean).join(' · ');

  return (
    <>
      <PageHeader icon="database" hue="term" title={name} subtitle={subtitle} back />
      <section className="dk-cr-card" aria-label={t('volume.users')}>
        <h3>{t('volume.users')}</h3>
        <UsedBy list={users} max={12} />
      </section>
      <BrowseCard name={name} size={size} ensureImage={image.ensure} track={track} />
      <BackupCard name={name} size={size} users={users} ensureImage={image.ensure} track={track} />
      {jobsHere() && !isAnonymousVolume(name) && <ScheduleCard name={name} />}
      <RestoreCard name={name} users={users} ensureImage={image.ensure} track={track} />
      {image.dialog}
    </>
  );
}

interface CardProps {
  name: string;
  ensureImage(): Promise<string>;
  track(h: Helper): Helper;
}

function BrowseCard({ name, size, ensureImage, track }: CardProps & { size: number }) {
  const [helper, setHelper] = useState<Helper | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef<Helper | null>(null);
  useEffect(() => () => void current.current?.remove().catch(() => undefined), []);

  const open = async () => {
    setBusy(true);
    try {
      const img = await ensureImage();
      const h = track(await createHelper(img, name, 'ro', 'browse', size));
      current.current = h;
      setHelper(h);
    } catch (e) {
      toast.err(t('volume.browse.fail'), errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    const h = current.current;
    current.current = null;
    setHelper(null);
    void h?.remove().catch(() => undefined);
  };

  return (
    <section className="dk-cr-card" aria-label={t('volume.browse.title')}>
      <div className="dk-bd-top">
        <h3>{t('volume.browse.title')}</h3>
        {helper && <Button size="sm" variant="ghost" icon="close" onClick={close}>{t('volume.browse.close')}</Button>}
      </div>
      {helper ? (
        <FilesTab id={helper.id} running root={VOLUME_ROOT} readOnly />
      ) : (
        <>
          <p className="dk-muted dk-bk-p">{t('volume.browse.text')}</p>
          <div className="dk-cr-row"><Button icon="files" loading={busy} onClick={() => void open()}>{t('volume.browse.open')}</Button></div>
        </>
      )}
    </section>
  );
}

function BackupCard({ name, size, users, ensureImage, track }: CardProps & { size: number; users: Container[] }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const running = users.filter((c) => c.State === 'running');

  const run = async () => {
    setBusy(true);
    setNote('');
    try {
      const img = await ensureImage();
      // Not removed here: the browser keeps reading the stream after download() returns. The helper ends by itself.
      const h = await createHelper(img, name, 'ro', 'backup', size);
      try {
        const r = await startBackup(h, name);
        toast.ok(t('volume.backup.started', { name: r.filename }));
        setNote(t('volume.backup.helper', { min: Math.ceil(lifetimeFor('backup', size) / 60) }));
      } catch (e) {
        await h.remove().catch(() => undefined);
        throw e;
      }
    } catch (e) {
      toast.err(t('volume.backup.fail'), errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="dk-vol-backup" className="dk-cr-card" aria-label={t('volume.backup.title')}>
      <h3>{t('volume.backup.title')}</h3>
      <p className="dk-muted dk-bk-p">{t('volume.backup.text')}</p>
      {running.length > 0 && <Hint tone="warn" icon="alert">{t('volume.backup.running', { names: running.map(containerName).join(', ') })}</Hint>}
      <div className="dk-cr-row"><Button variant="primary" icon="download" loading={busy} onClick={() => void run()}>{t('volume.backup.go')}</Button></div>
      {note && <p className="dk-muted dk-bk-p"><Icon name="info" size={13} /> {note}</p>}
    </section>
  );
}

type Phase = '' | 'prepare' | 'stop' | 'empty' | 'send' | 'start';

function RestoreCard({ name, users, ensureImage, track }: CardProps & { users: Container[] }) {
  const [file, setFile] = useState<File | null>(null);
  const [empty, setEmpty] = useState(false);
  const running = users.filter((c) => c.State === 'running');
  const [stopThem, setStopThem] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [phase, setPhase] = useState<Phase>('');
  const [pct, setPct] = useState<{ loaded: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const xfer = useRef<{ cancel(): void } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const busy = phase !== '';

  const pick = async (f: File | undefined) => {
    if (input.current) input.current.value = '';
    if (!f) return;
    setFile(f);
    setError('');
    setDone(false);
    if ((await restoreRoot(f).catch(() => undefined)) === undefined) setError(t('volume.restore.notTar'));
  };

  const run = async () => {
    if (!file) return;
    setError('');
    setDone(false);
    setPhase('prepare');
    const stopped: string[] = [];
    let helper: Helper | undefined;
    try {
      const root = await restoreRoot(file);
      if (!root) throw new Error(t('volume.restore.notTar'));
      const img = await ensureImage();
      if (stopThem) {
        setPhase('stop');
        for (const c of running) {
          await docker.post(`/containers/${c.Id}/stop`, { t: '30' });
          stopped.push(c.Id);
        }
      }
      helper = track(await createHelper(img, name, 'rw', 'restore'));
      if (empty) {
        setPhase('empty');
        await emptyVolume(helper);
      }
      setPhase('send');
      setPct({ loaded: 0, total: file.size });
      const x = sendRestore(helper, root, file, setPct);
      xfer.current = x;
      await x.done;
      setDone(true);
      toast.ok(t('volume.restore.done', { name }));
      void diskUsage.refresh();
    } catch (e) {
      const cancelled = (e as { code?: string })?.code === 'cancelled';
      if (cancelled) toast.info(t('volume.restore.cancelled'));
      else setError(errorText(e));
    } finally {
      xfer.current = null;
      await helper?.remove().catch(() => undefined);
      if (stopped.length) {
        setPhase('start');
        for (const id of stopped) await docker.post(`/containers/${id}/start`).catch((e) => toast.err(t('volume.restore.startFail'), errorText(e)));
        void containers.refresh();
      }
      setPhase('');
      setPct(null);
    }
  };

  const start = () => (empty ? setConfirm(true) : void run());
  const label: Record<Exclude<Phase, ''>, string> = {
    prepare: t('volume.restore.p.prepare'),
    stop: t('volume.restore.p.stop'),
    empty: t('volume.restore.p.empty'),
    send: t('volume.restore.p.send'),
    start: t('volume.restore.p.start'),
  };

  return (
    <section id="dk-vol-restore" className="dk-cr-card" aria-label={t('volume.restore.title')}>
      <h3>{t('volume.restore.title')}</h3>
      <p className="dk-muted dk-bk-p">{t('volume.restore.text')}</p>
      <div className="dk-cr-row">
        <Button icon="file" disabled={busy} onClick={() => input.current?.click()}>{t('volume.restore.choose')}</Button>
        <input ref={input} type="file" hidden accept=".tar,.tgz,.gz,.tar.gz,application/x-tar,application/gzip" data-testid="restore-file" onChange={(e) => void pick(e.target.files?.[0])} />
        {file ? <span><code>{file.name}</code> <span className="dk-muted">{formatBytes(file.size)}</span></span> : <span className="dk-muted">{t('volume.restore.none')}</span>}
      </div>
      <Checkbox checked={empty} disabled={busy} onChange={setEmpty} label={t('volume.restore.empty')} />
      {empty && <Hint tone="warn" icon="alert">{t('volume.restore.emptyWarn')}</Hint>}
      {running.length > 0 && (
        <>
          <Hint tone="warn" icon="alert">{t('volume.restore.running', { names: running.map(containerName).join(', ') })}</Hint>
          <Checkbox checked={stopThem} disabled={busy} onChange={setStopThem} label={t('volume.restore.stop')} />
        </>
      )}
      <div className="dk-cr-row">
        <Button variant="primary" icon="upload" loading={busy} disabled={!file || busy || (!!error && !done)} onClick={start}>{t('volume.restore.go')}</Button>
        {phase === 'send' && <Button variant="ghost" icon="close" onClick={() => xfer.current?.cancel()}>{t('common.cancel')}</Button>}
      </div>
      {phase && (
        <div className="dk-bd-send" role="status">
          <small>{label[phase]}{phase === 'send' && pct ? `: ${formatBytes(pct.loaded)} / ${formatBytes(pct.total)}` : ''}</small>
          {phase === 'send' && pct && <Progress value={pct.total ? (pct.loaded / pct.total) * 100 : 0} />}
        </div>
      )}
      {error && <Hint tone="err" icon="alert">{error}</Hint>}
      {done && !busy && <p className="dk-okmsg"><Icon name="check" />{t('volume.restore.done', { name })}</p>}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => { setConfirm(false); void run(); }}
        title={t('volume.restore.confirmTitle', { name })}
        description={t('volume.restore.confirmText')}
        confirmLabel={t('volume.restore.confirmGo')}
        confirmText={name}
        icon="trash"
        danger
      >
        {users.length > 0 && <p className="dk-warn-p"><Icon name="alert" />{t('volume.restore.confirmUsers', { names: users.map(containerName).join(', ') })}</p>}
        {running.length > 0 && <p className="dk-muted">{stopThem ? t('volume.restore.confirmStop') : t('volume.restore.confirmNoStop')}</p>}
      </ConfirmDialog>
    </section>
  );
}

/** Scheduled backups of this volume (the schedules run on this server). */
function ScheduleCard({ name }: { name: string }) {
  const [adding, setAdding] = useState(false);
  return (
    <section id="dk-vol-schedule" className="dk-cr-card" aria-label={t('bk.card.title')}>
      <h3>{t('bk.card.title')}</h3>
      <p className="dk-muted dk-bk-p">{t('bk.card.text')}</p>
      {!adding && <div className="dk-cr-row"><Button icon="clock" onClick={() => setAdding(true)}>{t('bk.menu.schedule')}</Button></div>}
      <BackupSchedules volumes={[name]} only={name} prefill={name} adding={adding} onDone={() => setAdding(false)} />
    </section>
  );
}
