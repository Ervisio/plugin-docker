import { useEffect, useRef, useState, type ReactNode } from 'react';
import { errorText } from '../../api/engine';
import { findHelperImage, HELPER_IMAGE } from '../../api/volumes';
import { t } from '../../i18n';
import { Button, Dialog, Progress } from '../../kit';
import { pullImage, type PullState } from '../resources/pull';
import { images } from '../../api/resources';

/**
 * The helper image for volume tools. ensure() resolves with the name of a busybox image that is here, and when there is
 * none, asks first (a dialog) and pulls HELPER_IMAGE with progress. It rejects when the user says no.
 */
export function useHelperImage(): { ensure(): Promise<string>; dialog: ReactNode } {
  const [ask, setAsk] = useState<{ resolve(ref: string): void; reject(e: Error): void } | null>(null);
  const [pull, setPull] = useState<PullState | null>(null);
  const [error, setError] = useState('');
  const handle = useRef<{ close(): void } | null>(null);
  useEffect(() => () => handle.current?.close(), []);

  const ensure = async (): Promise<string> => {
    const have = await findHelperImage();
    if (have) return have;
    return new Promise<string>((resolve, reject) => {
      setPull(null);
      setError('');
      setAsk({ resolve, reject });
    });
  };

  const close = (e?: Error) => {
    handle.current?.close();
    ask?.reject(e ?? new Error(t('volume.image.declined')));
    setAsk(null);
  };
  const go = () => {
    setError('');
    setPull({ layers: [], message: '', finished: false });
    handle.current = pullImage(HELPER_IMAGE, (s) => {
      setPull(s);
      if (s.error) setError(s.error);
      else if (s.finished) {
        void images.refresh();
        handle.current = null;
        ask?.resolve(HELPER_IMAGE);
        setAsk(null);
      }
    });
  };
  const pulling = !!pull && !pull.finished && !pull.error;
  const pct = pull && pull.layers.length ? (pull.layers.reduce((a, l) => a + l.pct, 0) / pull.layers.length) * 100 : 0;

  const dialog = (
    <Dialog
      open={!!ask}
      onClose={() => !pulling && close()}
      title={t('volume.image.title')}
      description={t('volume.image.text', { image: HELPER_IMAGE })}
      icon="download"
      footer={
        <>
          <Button variant="ghost" onClick={() => close()}>{pulling ? t('common.cancel') : t('volume.image.no')}</Button>
          <Button variant="primary" icon="download" loading={pulling} disabled={pulling} onClick={go}>{t('volume.image.pull', { image: HELPER_IMAGE })}</Button>
        </>
      }
    >
      {pulling && <Progress value={pct} label={pull?.message || t('volume.image.pulling')} />}
      {error && <p className="dk-fail">{errorText(new Error(error))}</p>}
    </Dialog>
  );
  return { ensure, dialog };
}
