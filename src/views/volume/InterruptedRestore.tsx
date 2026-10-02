import { useCallback, useEffect, useState } from 'react';
import { docker, errorText } from '../../api/engine';
import { useEnv } from '../../api/useEnv';
import { containers } from '../../api/resources';
import { forgetRestore, interruptedFor, planRestart, readJournal, type RestoreEntry } from '../../api/restoreJournal';
import { t } from '../../i18n';
import { Button, Icon, toast } from '../../kit';

/**
 * "A restore stopped containers and never started them": shown on Volumes when a restore record is still there (the
 * page closed in the middle). One click starts them and clears the record. See api/restoreJournal.ts.
 */
export function InterruptedRestore({ volume }: { volume?: string }) {
  const { env } = useEnv();
  const [entries, setEntries] = useState<RestoreEntry[]>([]);
  const [busy, setBusy] = useState('');
  const list = containers.use().data;

  const load = useCallback(async () => {
    try {
      setEntries(interruptedFor(await readJournal(), env));
    } catch {
      setEntries([]);
    }
  }, [env]);
  useEffect(() => { void load(); }, [load]);

  // A record whose containers all run again (or are gone) is stale: drop it quietly.
  useEffect(() => {
    if (!list) return;
    for (const e of entries) {
      const p = planRestart(e, list);
      if (!p.start.length) void forgetRestore(e.id).then(load, () => undefined);
    }
  }, [entries, list, load]);

  const shown = entries.filter((e) => (!volume || e.volume === volume) && list && planRestart(e, list).start.length > 0);
  if (!shown.length) return null;

  const restart = async (e: RestoreEntry) => {
    setBusy(e.id);
    let failed = 0;
    for (const c of planRestart(e, list ?? []).start) {
      try {
        await docker.post(`/containers/${c.id}/start`);
      } catch (err) {
        failed++;
        toast.err(t('volume.restore.startFail'), `${c.name}: ${errorText(err)}`);
      }
    }
    if (!failed) {
      await forgetRestore(e.id).catch(() => undefined);
      toast.ok(t('volume.interrupted.started', { volume: e.volume }));
    }
    void containers.refresh();
    await load();
    setBusy('');
  };
  const dismiss = async (e: RestoreEntry) => {
    await forgetRestore(e.id).catch(() => undefined);
    await load();
  };

  return (
    <>
      {shown.map((e) => (
        <div key={e.id} className="dk-jb-warn dk-vol-interrupted" role="alert">
          <Icon name="alert" />
          <div>
            <b>{t('volume.interrupted.title', { volume: e.volume })}</b>
            <p>{t('volume.interrupted.text', { names: planRestart(e, list ?? []).start.map((c) => c.name).join(', ') })}</p>
            <div className="dk-cr-row">
              <Button size="sm" variant="primary" icon="play" loading={busy === e.id} onClick={() => void restart(e)}>{t('volume.interrupted.start')}</Button>
              <Button size="sm" variant="ghost" disabled={busy === e.id} onClick={() => void dismiss(e)}>{t('volume.interrupted.dismiss')}</Button>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
