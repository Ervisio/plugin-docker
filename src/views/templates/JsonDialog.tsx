import { errorText } from '../../api/engine';
import { t } from '../../i18n';
import { Button, Dialog, Textarea, toast } from '../../kit';
import { getSdk } from '../../sdk';
import { copyText } from '../container/util';
import type { ReactNode } from 'react';

/** Shows a JSON file's text with Copy and Download. */
export function JsonDialog({ open, onClose, title, text, file, children }: { open: boolean; onClose(): void; title: string; text: string; file: string; children?: ReactNode }) {
  const copy = async () => {
    if (await copyText(text)) toast.ok(t('export.copied'));
    else toast.err(t('container.copyFail'));
  };
  const save = async () => {
    try {
      const r = await getSdk().saveFile(file.replace(/[^a-zA-Z0-9_.-]/g, '_'), text, 'application/json');
      toast.ok(t('export.saved'), r.filename);
    } catch (e) {
      toast.err(t('export.saveFail'), errorText(e));
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <>
          <Button icon="copy" onClick={() => void copy()}>{t('common.copy')}</Button>
          <Button variant="primary" icon="download" onClick={() => void save()}>{t('export.save')}</Button>
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        </>
      }
    >
      {children}
      <Textarea mono rows={14} value={text} readOnly aria-label={title} spellCheck={false} onChange={() => undefined} />
    </Dialog>
  );
}
