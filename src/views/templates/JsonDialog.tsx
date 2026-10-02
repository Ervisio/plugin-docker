import { saveExport } from '../../api/exports';
import { errorText } from '../../api/engine';
import { t } from '../../i18n';
import { Button, Dialog, Icon, Textarea, toast } from '../../kit';
import { copyText } from '../container/util';
import { useState, type ReactNode } from 'react';

/** Shows a JSON file's text with Copy and Save to a file. (The frame cannot start a download, see api/exports.ts.) */
export function JsonDialog({ open, onClose, title, text, file, savedPath = '', children }: { open: boolean; onClose(): void; title: string; text: string; file: string; /** Where the text was already saved. */ savedPath?: string; children?: ReactNode }) {
  const [savedNow, setSaved] = useState('');
  const saved = savedNow || savedPath;
  const copy = async () => {
    if (await copyText(text)) toast.ok(t('export.copied'));
    else toast.err(t('container.copyFail'));
  };
  const save = async () => {
    try {
      const path = await saveExport(file, text);
      setSaved(path);
      toast.ok(t('export.saved'), path);
    } catch (e) {
      toast.err(t('export.saveFail'), errorText(e));
    }
  };
  return (
    <Dialog
      open={open}
      onClose={() => { setSaved(''); onClose(); }}
      title={title}
      size="lg"
      footer={
        <>
          <Button icon="copy" onClick={() => void copy()}>{t('common.copy')}</Button>
          <Button variant="primary" icon="download" onClick={() => void save()}>{t('export.save')}</Button>
          <Button variant="ghost" onClick={() => { setSaved(''); onClose(); }}>{t('common.close')}</Button>
        </>
      }
    >
      {children}
      <Textarea mono rows={14} value={text} readOnly aria-label={title} spellCheck={false} onChange={() => undefined} />
      {saved && <p className="dk-muted"><Icon name="check" size={13} /> {t('export.savedTo', { path: saved })}</p>}
    </Dialog>
  );
}
