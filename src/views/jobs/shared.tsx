import { useEffect, useState } from 'react';
import { approvalOf, jobsApi, runFailed, type JobInstance, type JobRun } from '../../api/jobs';
import { useEnv } from '../../api/useEnv';
import { relativeTime } from '../../api/format';
import { appOrigin } from '../../api/appOrigin';
import { t } from '../../i18n';
import { Badge, Button, Icon, toast } from '../../kit';

export { appOrigin };

export const ago = (ms: number): string => relativeTime(ms / 1000);

/** Shown in place of the job controls while another Docker host is open (jobs always run on this server). */
export function LocalOnlyNote({ compact }: { compact?: boolean }) {
  const { info } = useEnv();
  if (compact) return <p className="dk-muted dk-jb-p"><Icon name="info" /> {t('envs.jobs.short')}</p>;
  return (
    <div className="dk-jb-warn" role="status">
      <Icon name="info" />
      <div><b>{t('envs.jobs.title')}</b><p>{t('envs.jobs.text', { env: info?.name ?? '' })}</p></div>
    </div>
  );
}

/** One line: "Waiting for approval", "Switched off" or nothing. */
export function ApprovalNote({ inst }: { inst: JobInstance }) {
  const a = approvalOf(inst);
  if (a === 'waiting') {
    return (
      <div className="dk-jb-warn" role="status">
        <Icon name="alert" />
        <div><b>{t('jobs.waiting.title')}</b><p>{t('jobs.waiting.text')}</p></div>
      </div>
    );
  }
  if (a === 'off') {
    return (
      <div className="dk-jb-warn" role="status">
        <Icon name="alert" />
        <div><b>{t('jobs.off.title')}</b><p>{inst.disabledReason || t('jobs.off.text')}</p></div>
      </div>
    );
  }
  return null;
}

/** The newest run of an instance, with its steps (a handled failure shows there, not in `inst.last`). */
export function useLastRun(inst: JobInstance | undefined): JobRun | undefined {
  const [run, setRun] = useState<JobRun>();
  const id = inst?.id;
  const last = inst?.last?.id;
  useEffect(() => {
    let live = true;
    if (!id || !last) { setRun(undefined); return; }
    jobsApi().history(id, 1).then((r) => { if (live) setRun(r[0]); }, () => undefined);
    return () => { live = false; };
  }, [id, last]);
  return run;
}

/** Status badge for the last run of an instance; a run whose failed step was reported by a notification counts as failed. */
export function LastRun({ inst, run }: { inst: JobInstance; run?: JobRun }) {
  const l = inst.last;
  if (inst.running) return <Badge tone="info" dot>{t('jobs.running')}</Badge>;
  if (!l) return <span className="dk-muted">{t('jobs.neverRun')}</span>;
  const bad = l.status === 'failed' || l.status === 'timeout' || (!!run && run.id === l.id && runFailed(run));
  const failedStep = run?.steps.find((s) => s.status === 'failed');
  return (
    <span className="dk-jb-last">
      <Badge tone={bad ? 'err' : l.status === 'ok' ? 'ok' : 'neutral'} dot>{bad && l.status === 'ok' ? t('jobs.status.failed') : t(`jobs.status.${l.status}`)}</Badge>
      <span className="dk-muted">{ago(l.ended ?? l.started)}</span>
      {bad && failedStep && <span className="dk-sk-err">{(failedStep.stderr || failedStep.error || failedStep.id).trim().split('\n').slice(-1)[0]}</span>}
    </span>
  );
}

/** Runs of an instance with their steps. */
export function RunList({ runs, empty }: { runs: JobRun[]; empty: string }) {
  const [open, setOpen] = useState<string>();
  if (!runs.length) return <p className="dk-muted">{empty}</p>;
  return (
    <ul className="dk-jb-runs">
      {runs.map((r) => {
        const bad = runFailed(r);
        const show = open === r.id;
        return (
          <li key={r.id}>
            <button type="button" className="dk-jb-run" aria-expanded={show} onClick={() => setOpen(show ? undefined : r.id)}>
              <span className={`dk-dot dk-dot--${r.status === 'running' || r.status === 'queued' ? 'info' : bad ? 'err' : 'ok'}`} />
              <b>{t(`jobs.trigger.${r.trigger}`)}</b>
              <span className="dk-muted">{ago(r.started)}</span>
              <Badge tone={bad ? 'err' : r.status === 'ok' ? 'ok' : 'neutral'}>{t(`jobs.status.${r.status}`)}</Badge>
              <Icon name={show ? 'chevronup' : 'chevron'} />
            </button>
            {show && (
              <div className="dk-jb-steps">
                {r.error && <p className="dk-sk-err">{r.error}</p>}
                {r.steps.map((s) => (
                  <div key={s.id} className="dk-jb-step">
                    <span className={`dk-jb-st dk-jb-st--${s.status}`}>{s.id}</span>
                    <span className="dk-muted">{t(`jobs.step.${s.status}`)}{s.handled ? ` (${t('jobs.step.handled')})` : ''}{s.exitCode !== undefined && s.exitCode !== 0 ? `, ${t('jobs.step.exit', { code: s.exitCode })}` : ''}</span>
                    {(s.stderr || s.stdout || s.error) && <pre>{(s.error || '') + (s.stderr || s.stdout || '').trim()}</pre>}
                  </div>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** "Run now" with a toast. */
export function RunNowButton({ inst, after }: { inst: JobInstance; after(): void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button size="sm" icon="play" loading={busy} disabled={approvalOf(inst) !== 'ok' || inst.running} onClick={async () => {
      setBusy(true);
      try {
        await jobsApi().runNow(inst.id);
        toast.ok(t('jobs.started'));
      } catch (e) {
        toast.err(t('jobs.startFail'), (e as Error).message);
      } finally {
        setBusy(false);
        setTimeout(after, 1500);
      }
    }}>{t('jobs.runNow')}</Button>
  );
}
