import { useMemo, useState } from 'react';
import { deleteCustomTemplate, duplicateCustomTemplate, saveCustomTemplate, TEMPLATES_DIR } from '../../api/customTemplates';
import { errorText } from '../../api/engine';
import { importTemplates, templateFileText, type Template } from '../../api/templateModel';
import { t, tn } from '../../i18n';
import { Button, Dialog, DropdownMenu, Icon, IconButton, Textarea, toast } from '../../kit';
import { navigate } from '../../router';
import { FilePicker } from '../../ui/FilePicker';
import { Confirm } from '../stack/Confirm';
import { JsonDialog } from './JsonDialog';

/** Edit, duplicate, export and delete for one custom template. */
export function CustomMenu({ tpl, onDeleted, stop }: { tpl: Template; onDeleted?(): void; /** Keep clicks from reaching a clickable card around the menu. */ stop?: boolean }) {
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const file = tpl.custom?.file ?? '';

  const duplicate = async () => {
    try {
      const copy = await duplicateCustomTemplate(tpl, t('templates.custom.copyOf', { name: tpl.name }));
      toast.ok(t('templates.custom.duplicated', { name: copy.name }));
    } catch (e) {
      toast.err(t('templates.custom.saveFail'), errorText(e));
    }
  };
  const remove = async () => {
    try {
      await deleteCustomTemplate(file);
      toast.ok(t('templates.custom.deleted', { name: tpl.name }));
      onDeleted?.();
    } catch (e) {
      toast.err(t('templates.custom.deleteFail'), errorText(e));
    }
  };

  return (
    <>
      <DropdownMenu
        aria-label={t('templates.custom.menu', { name: tpl.name })}
        items={[
          { id: 'edit', label: t('templates.custom.edit'), icon: 'edit', onSelect: () => navigate({ view: 'template-edit', id: tpl.id }) },
          { id: 'dup', label: t('templates.custom.duplicate'), icon: 'copy', onSelect: () => void duplicate() },
          { id: 'exp', label: t('templates.custom.export'), icon: 'download', onSelect: () => setExporting(true) },
          { type: 'separator' },
          { id: 'del', label: t('templates.custom.delete'), icon: 'trash', danger: true, onSelect: () => setDeleting(true) },
        ]}
        trigger={(p) => (
          <IconButton variant="ghost" icon="more" label={t('templates.custom.menu', { name: tpl.name })} {...p} onClick={(e) => { if (stop) e.stopPropagation(); p.onClick(e); }} />
        )}
      />
      <JsonDialog open={exporting} onClose={() => setExporting(false)} title={t('templates.custom.exportTitle', { name: tpl.name })} text={templateFileText(tpl)} file={`template-${file}.json`}>
        <p className="dk-muted">{t('templates.custom.exportNote')}</p>
      </JsonDialog>
      <Confirm
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => { setDeleting(false); void remove(); }}
        title={t('templates.custom.deleteTitle', { name: tpl.name })}
        description={t('templates.custom.deleteText', { dir: TEMPLATES_DIR })}
        confirmLabel={t('templates.custom.delete')}
        danger
        icon="trash"
      />
    </>
  );
}

/** Import templates from pasted or uploaded JSON (a Portainer list, or a file exported here). */
export function ImportTemplatesDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return { ...importTemplates(text), error: '' };
    } catch (e) {
      return { templates: [] as Template[], skipped: 0, error: (e as Error).message };
    }
  }, [text]);

  const close = () => { setText(''); onClose(); };
  const run = async () => {
    if (!parsed?.templates.length) return;
    setBusy(true);
    let n = 0;
    try {
      for (const tpl of parsed.templates) {
        await saveCustomTemplate({ ...tpl, custom: undefined });
        n++;
      }
      toast.ok(tn('templates.custom.imported', { n }));
      close();
    } catch (e) {
      toast.err(t('templates.custom.saveFail'), errorText(e) + (n ? ' ' + t('templates.custom.importPartial', { n }) : ''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('templates.custom.importTitle')}
      description={t('templates.custom.importText')}
      size="lg"
      footer={
        <>
          <Button variant="primary" icon="upload" loading={busy} disabled={!parsed?.templates.length || busy} onClick={() => void run()}>{tn('templates.custom.importDo', { n: parsed?.templates.length ?? 0 })}</Button>
          <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
        </>
      }
    >
      <Textarea mono rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "version": "3", "templates": [ … ] }' aria-label={t('templates.custom.importTitle')} spellCheck={false} />
      <div className="dk-cr-row"><FilePicker label={t('templates.custom.chooseFile')} accept=".json,application/json" onText={(txt) => setText(txt)} onError={() => toast.err(t('templates.custom.readFail'))} /></div>
      {parsed?.error && <div className="dk-cr-hint dk-cr-hint--err" role="alert"><Icon name="alert" size={14} /><span>{parsed.error}</span></div>}
      {parsed && !parsed.error && (
        <div className="dk-cr-hint dk-cr-hint--ok">
          <Icon name="check" size={14} />
          <span>
            {tn('templates.custom.importFound', { n: parsed.templates.length })} {parsed.templates.slice(0, 6).map((x) => x.name).join(', ')}{parsed.templates.length > 6 ? '…' : ''}
            {parsed.skipped ? ` ${tn('templates.custom.importSkipped', { n: parsed.skipped })}` : ''}
          </span>
        </div>
      )}
    </Dialog>
  );
}
