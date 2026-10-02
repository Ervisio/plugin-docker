import { useEffect, useState } from 'react';
import type { GitMeta } from '../../api/gitMeta';
import { jobsApi, modeOfJob, pollJob, POLL_JOBS, useInstances, type NotifyMode } from '../../api/jobs';
import { t } from '../../i18n';
import { Button, Card, Switch, toast } from '../../kit';
import { ApprovalNote, LastRun, RunNowButton, ago, useLastRun } from './shared';
import { NotifyPicker, SchedulePicker, scheduleLabel, isOff, type ScheduleValue } from './Schedule';

/** "Update automatically" of a Git stack: a job instance that fetches, compares, pulls and redeploys when the ref moved. */
export function AutoUpdateCard({ name, meta, onChanged }: { name: string; meta: GitMeta; onChanged?(): void }) {
  const { list, loading, reload } = useInstances(POLL_JOBS);
  const inst = list.find((i) => i.params.name === name);
  const lastRun = useLastRun(inst);
  const [editing, setEditing] = useState(false);
  const [sched, setSched] = useState<ScheduleValue>({ every: 1800 });
  const [mode, setMode] = useState<NotifyMode>('f');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (inst) {
      setSched(inst.schedule?.every ? { every: inst.schedule.every } : inst.schedule?.at ? { at: inst.schedule.at, days: inst.schedule.days } : { off: true });
      setMode(modeOfJob(inst.job));
    }
  }, [inst?.id, inst?.job, inst?.schedule?.every, inst?.schedule?.at?.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const params = { name, ref: meta.ref, file: meta.compose };

  const save = async () => {
    setBusy(true);
    try {
      const api = jobsApi();
      if (isOff(sched)) {
        if (inst) await api.delete(inst.id);
      } else if (!inst) {
        await api.create({ job: pollJob(mode), name: `Update ${name}`, params, schedule: sched });
      } else if (inst.job !== pollJob(mode)) {
        // The notification choice is a different job: replace the instance (its webhook-free, so nothing is lost).
        await api.delete(inst.id);
        await api.create({ job: pollJob(mode), name: `Update ${name}`, params, schedule: sched });
      } else {
        await api.update(inst.id, { params, schedule: sched, enabled: true });
      }
      toast.ok(isOff(sched) ? t('auto.off.done') : t('auto.saved'));
      setEditing(false);
      await reload();
      onChanged?.();
    } catch (e) {
      toast.err(t('auto.saveFail'), (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (on: boolean) => {
    if (!on && inst) {
      setBusy(true);
      try {
        await jobsApi().delete(inst.id);
        await reload();
      } catch (e) {
        toast.err(t('auto.saveFail'), (e as Error).message);
      } finally {
        setBusy(false);
      }
    } else {
      setSched({ every: 1800 });
      setEditing(true);
    }
  };

  return (
    <Card title={t('auto.title')} icon="clock" action={<Switch checked={!!inst || editing} disabled={busy || loading} aria-label={t('auto.title')} onChange={(on) => void toggle(on)} />}>
      <p className="dk-muted dk-jb-p">{t('auto.intro', { ref: meta.ref })}</p>
      {inst && !editing && (
        <>
          <ApprovalNote inst={inst} />
          <dl className="dk-jb-facts">
            <div><dt>{t('auto.runs')}</dt><dd>{scheduleLabel(inst.schedule)}</dd></div>
            <div><dt>{t('auto.next')}</dt><dd>{inst.nextRun ? ago(inst.nextRun) : '–'}</dd></div>
            <div><dt>{t('auto.last')}</dt><dd><LastRun inst={inst} run={lastRun} /></dd></div>
            <div><dt>{t('notify.mode')}</dt><dd>{t(`notify.mode.${modeOfJob(inst.job)}`)}</dd></div>
          </dl>
          <div className="dk-jb-btns">
            <Button size="sm" icon="edit" onClick={() => setEditing(true)}>{t('common.edit')}</Button>
            <RunNowButton inst={inst} after={() => void reload()} />
          </div>
        </>
      )}
      {editing && (
        <div className="dk-jb-form">
          <SchedulePicker value={sched} onChange={setSched} allowOff={false} />
          <NotifyPicker value={mode} onChange={setMode} />
          <div className="dk-jb-btns">
            <Button variant="primary" loading={busy} onClick={() => void save()}>{t('common.save')}</Button>
            <Button variant="ghost" onClick={() => { setEditing(false); void reload(); }}>{t('common.cancel')}</Button>
          </div>
        </div>
      )}
      {!inst && !editing && <p className="dk-muted">{t('auto.none')}</p>}
    </Card>
  );
}
