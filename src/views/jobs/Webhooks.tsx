import { useCallback, useEffect, useState } from 'react';
import { jobsApi, useInstances, type JobInstance, type JobRun } from '../../api/jobs';
import { t } from '../../i18n';
import { Button, Card, Dialog, Icon, IconButton, Input, toast } from '../../kit';
import { copyText } from '../resources/bits';
import { ago, ApprovalNote, appOrigin, RunList } from './shared';

/**
 * "Redeploy webhook" of a stack or a container: one job instance without a schedule, up to five URLs. A URL is shown
 * once (the daemon keeps only a hash); regenerate gives a new one and kills the old.
 */
export function WebhookCard({ job, params, label, intro, hue }: {
  job: string;
  /** Params that identify the target: the instance is the one of `job` with exactly these. */
  params: Record<string, string>;
  /** Name of the instance in Settings › Plugin jobs. */
  label: string;
  intro: string;
  hue?: string;
}) {
  const { list, loading, error, reload } = useInstances([job]);
  const inst = list.find((i) => Object.entries(params).every(([k, v]) => i.params[k] === v));
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ url: string; path: string } | null>(null);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [revoking, setRevoking] = useState<string>();

  const loadRuns = useCallback(async () => {
    if (!inst) return setRuns([]);
    try {
      setRuns((await jobsApi().history(inst.id, 20)).filter((r) => r.trigger === 'webhook').slice(0, 8));
    } catch { /* keep the old list */ }
  }, [inst?.id, inst?.last?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadRuns(); }, [loadRuns]);

  const reveal = (path: string) => setShown({ path, url: `${appOrigin()}${path}` });

  const create = async () => {
    setBusy(true);
    try {
      const i = inst ?? (await jobsApi().create({ job, name: label, params }));
      const w = await jobsApi().webhooks.create(i.id, '');
      reveal(w.path);
      await reload();
    } catch (e) {
      toast.err(t('hooks.createFail'), (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const regenerate = async (i: JobInstance, id: string) => {
    try {
      const w = await jobsApi().webhooks.regenerate(i.id, id);
      reveal(w.path);
      await reload();
    } catch (e) {
      toast.err(t('hooks.regenFail'), (e as Error).message);
    }
  };
  const revoke = async (i: JobInstance, id: string) => {
    try {
      await jobsApi().webhooks.revoke(i.id, id);
      toast.ok(t('hooks.revoked'));
      await reload();
    } catch (e) {
      toast.err(t('hooks.revokeFail'), (e as Error).message);
    } finally {
      setRevoking(undefined);
    }
  };

  const hooks = inst?.webhooks ?? [];
  return (
    <Card title={t('hooks.title')} icon="link" hue={hue as never}>
      <p className="dk-muted dk-jb-p">{intro}</p>
      {error && <p className="dk-sk-err">{error}</p>}
      {inst && <ApprovalNote inst={inst} />}
      {hooks.length > 0 && (
        <ul className="dk-jb-hooks">
          {hooks.map((h) => (
            <li key={h.id}>
              <Icon name="link" />
              <div>
                <b>{h.label || t('hooks.row', { n: hooks.indexOf(h) + 1 })}</b>
                <span className="dk-muted">{t('hooks.created', { when: ago(h.created) })}{h.lastUsed ? ` · ${t('hooks.lastUsed', { when: ago(h.lastUsed) })}` : ` · ${t('hooks.neverUsed')}`}</span>
              </div>
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => void regenerate(inst!, h.id)}>{t('hooks.regenerate')}</Button>
              <Button size="sm" variant="ghost" icon="trash" onClick={() => setRevoking(h.id)}>{t('hooks.revoke')}</Button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button icon="plus" loading={busy} disabled={loading || hooks.length >= 5} onClick={() => void create()}>{hooks.length ? t('hooks.add') : t('hooks.create')}</Button>
      </div>
      {inst && hooks.length > 0 && (
        <>
          <h4 className="dk-jb-h">{t('hooks.calls')}</h4>
          <RunList runs={runs} empty={t('hooks.noCalls')} />
        </>
      )}
      <Dialog
        open={!!shown}
        onClose={() => setShown(null)}
        title={t('hooks.new.title')}
        description={t('hooks.new.text')}
        icon="link"
        footer={<Button variant="primary" onClick={() => setShown(null)}>{t('hooks.new.done')}</Button>}
      >
        {shown && (
          <>
            <Input mono readOnly label={t('hooks.url')} value={shown.url} onFocus={(e) => e.currentTarget.select()} end={<IconButton icon="copy" size="sm" variant="ghost" label={t('common.copy')} onClick={() => void copyText(shown.url)} />} />
            {!appOrigin() && <p className="dk-sk-err">{t('hooks.new.noOrigin')}</p>}
            <p className="dk-muted">{t('hooks.new.curl')}</p>
            <pre className="dk-jb-code">curl -X POST {shown.url}</pre>
          </>
        )}
      </Dialog>
      <Dialog
        open={!!revoking}
        onClose={() => setRevoking(undefined)}
        title={t('hooks.revoke.title')}
        description={t('hooks.revoke.text')}
        icon="trash"
        tone="err"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(undefined)}>{t('common.cancel')}</Button>
            <Button variant="danger-solid" onClick={() => inst && revoking && void revoke(inst, revoking)}>{t('hooks.revoke')}</Button>
          </>
        }
      />
    </Card>
  );
}
