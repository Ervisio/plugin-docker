import { useEffect, useState, type ReactNode } from 'react';
import { errorText } from '../../api/engine';
import { t } from '../../i18n';
import { Button, Dialog } from '../../kit';

/** A plain confirm dialog without a <form> (the plugin frame has no allow-forms). */
export function ConfirmBox({ open, onClose, onConfirm, title, description, confirmLabel, danger, icon }: {
  open: boolean;
  onClose(): void;
  onConfirm(): Promise<unknown>;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  icon?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) {
      setBusy(false);
      setErr('');
    }
  }, [open]);
  const run = async () => {
    setBusy(true);
    setErr('');
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={title}
      description={description}
      icon={icon ?? (danger ? 'trash' : 'alert')}
      tone={danger ? 'err' : 'warn'}
      role="alertdialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant={danger ? 'danger-solid' : 'primary'} loading={busy} onClick={() => void run()}>{confirmLabel}</Button>
        </>
      }
    >
      {err && <p className="dk-c-err" role="alert">{err}</p>}
    </Dialog>
  );
}
