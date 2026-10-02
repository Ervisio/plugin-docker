import { useEffect, useState } from 'react';
import { BACKUP_DIR, KEEP_DEFAULT, parseBackupList, validKeep, type BackupFile } from '../../api/backups';
import { formatBytes } from '../../api/format';
import { backupJob, BACKUP_JOBS, jobsApi, modeOfJob, useInstances, type JobInstance, type NotifyMode } from '../../api/jobs';
import { getSdk } from '../../sdk';
import { t } from '../../i18n';
import { Button, Card, Icon, IconButton, Input, Select, Switch, toast } from '../../kit';
import { ApprovalNote, LastRun, RunNowButton, ago, useLastRun } from './shared';
import { NotifyPicker, SchedulePicker, isOff, scheduleLabel, type ScheduleValue } from './Schedule';

/** Volumes › Schedule backups: the list of schedules, and the form that adds or edits one. */
export function BackupSchedules({ volumes, adding, prefill, only, onDone }: { volumes: string[]; adding: boolean; prefill?: string; /** show the schedules of this volume only */ only?: string; onDone(): void }) {
  const all = useInstances(BACKUP_JOBS);
  const { reload } = all;
  const list = only ? all.list.filter((i) => i.params.volume === only) : all.list;
  const [editing, setEditing] = useState<JobInstance | null>(null);
  const [removing, setRemoving] = useState<string>();
  if (!list.length && !adding) return null;
  return (
    <Card title={t('bk.title')} icon="archive">
      {(adding || editing) && (
        <BackupForm
          key={editing?.id ?? 'new'}
          volumes={volumes}
          inst={editing ?? undefined}
          prefill={prefill}
          onClose={() => { setEditing(null); onDone(); }}
          onSaved={() => { setEditing(null); onDone(); void reload(); }}
        />
      )}
      <div className="dk-bk-list">
        {list.map((i) => (
          <Row key={i.id} inst={i} reload={reload} onEdit={() => setEditing(i)} removing={removing === i.id} onRemove={(on) => setRemoving(on ? i.id : undefined)} />
        ))}
      </div>
      <p className="dk-muted dk-jb-p">{t('bk.where', { dir: BACKUP_DIR })}</p>
    </Card>
  );
}

function Row({ inst, reload, onEdit, removing, onRemove }: { inst: JobInstance; reload(): Promise<void>; onEdit(): void; removing: boolean; onRemove(on: boolean): void }) {
  const run = useLastRun(inst);
  const [files, setFiles] = useState<BackupFile[] | null>(null);
  const [open, setOpen] = useState(false);
  const volume = inst.params.volume;
  useEffect(() => {
    if (!open) return;
    getSdk().api.exec('volume-backup-ls', [volume]).then((r) => setFiles(r.exitCode === 0 ? parseBackupList(r.stdout) : []), () => setFiles([]));
  }, [open, volume, inst.last?.id]);
  const del = async () => {
    try {
      await jobsApi().delete(inst.id);
      toast.ok(t('bk.deleted'));
    } catch (e) {
      toast.err(t('bk.saveFail'), (e as Error).message);
    }
    onRemove(false);
    await reload();
  };
  return (
    <div className="dk-bk-row dk-bk-row--col">
      <div className="dk-bk-head">
        <div>
          <b>{volume}</b>
          <span className="dk-muted">{scheduleLabel(inst.schedule)} · {t('bk.keepN', { n: inst.params.keep ?? String(KEEP_DEFAULT) })} · {t(`notify.mode.${modeOfJob(inst.job)}`)}</span>
        </div>
        <LastRun inst={inst} run={run} />
        {inst.nextRun && <span className="dk-muted">{t('bk.next', { when: ago(inst.nextRun) })}</span>}
        <Switch checked={inst.enabled} aria-label={t('bk.on')} onChange={(on) => void jobsApi().update(inst.id, { enabled: on }).then(() => reload(), (e) => toast.err(t('bk.saveFail'), (e as Error).message))} />
        <RunNowButton inst={inst} after={() => void reload()} />
        <IconButton icon="archive" size="sm" variant="ghost" label={t('bk.files')} onClick={() => setOpen(!open)} />
        <IconButton icon="edit" size="sm" variant="ghost" label={t('common.edit')} onClick={onEdit} />
        {removing ? (
          <span className="dk-al-ask"><b>{t('bk.delete.ask')}</b><Button size="sm" variant="danger" onClick={() => void del()}>{t('common.remove')}</Button><Button size="sm" variant="ghost" onClick={() => onRemove(false)}>{t('common.cancel')}</Button></span>
        ) : (
          <IconButton icon="trash" size="sm" variant="ghost" label={t('bk.delete')} onClick={() => onRemove(true)} />
        )}
      </div>
      <ApprovalNote inst={inst} />
      {open && (
        <div className="dk-bk-files">
          {!files ? <span className="dk-muted">{t('common.loading')}</span> : files.length === 0 ? <span className="dk-muted">{t('bk.files.none')}</span> : (
            <table className="dk-table"><tbody>
              {files.map((f) => <tr key={f.name}><td className="dk-jb-mono">{f.name}</td><td className="dk-num">{formatBytes(f.size)}</td><td className="dk-muted">{f.when}</td></tr>)}
            </tbody></table>
          )}
          <p className="dk-muted">{t('bk.restore', { dir: `${BACKUP_DIR}/${volume}` })}</p>
        </div>
      )}
    </div>
  );
}

function BackupForm({ volumes, inst, prefill, onClose, onSaved }: { volumes: string[]; inst?: JobInstance; prefill?: string; onClose(): void; onSaved(): void }) {
  const [volume, setVolume] = useState(inst?.params.volume ?? prefill ?? volumes[0] ?? '');
  const [keep, setKeep] = useState(inst?.params.keep ?? String(KEEP_DEFAULT));
  const [sched, setSched] = useState<ScheduleValue>(inst?.schedule?.every ? { every: inst.schedule.every } : inst?.schedule?.at ? { at: inst.schedule.at, days: inst.schedule.days } : { at: ['03:30'] });
  const [mode, setMode] = useState<NotifyMode>(inst ? modeOfJob(inst.job) : 'f');
  const [busy, setBusy] = useState(false);
  const ok = !!volume && validKeep(keep) && !isOff(sched);
  const save = async () => {
    if (isOff(sched)) return;
    setBusy(true);
    try {
      const api = jobsApi();
      const params = { volume, keep };
      if (inst && inst.job === backupJob(mode)) await api.update(inst.id, { params, schedule: sched, enabled: true });
      else {
        if (inst) await api.delete(inst.id);
        await api.create({ job: backupJob(mode), name: `Backup ${volume}`, params, schedule: sched });
      }
      toast.ok(t('bk.saved'));
      onSaved();
    } catch (e) {
      toast.err(t('bk.saveFail'), (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dk-jb-form dk-bk-form">
      <h4 className="dk-jb-h">{inst ? t('bk.edit') : t('bk.new')}</h4>
      <div className="dk-fields dk-fields--2">
        <Select label={t('bk.volume')} value={volume} disabled={!!inst} options={(volumes.includes(volume) || !volume ? volumes : [volume, ...volumes]).map((v) => ({ value: v, label: v }))} onChange={setVolume} />
        <Input label={t('bk.keep')} type="number" min={1} max={999} value={keep} error={validKeep(keep) ? undefined : t('bk.keep.bad')} hint={t('bk.keep.hint')} onChange={(e) => setKeep(e.target.value)} />
      </div>
      <SchedulePicker value={sched} onChange={setSched} allowOff={false} intervals={[3600, 21600, 43200, 86400, 604800]} />
      <NotifyPicker value={mode} onChange={setMode} />
      <p className="dk-muted dk-jb-p"><Icon name="info" /> {t('bk.note')}</p>
      <div className="dk-jb-btns">
        <Button variant="primary" loading={busy} disabled={!ok} onClick={() => void save()}>{t('common.save')}</Button>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
      </div>
    </div>
  );
}
