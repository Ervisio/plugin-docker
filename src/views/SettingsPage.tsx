import { useEffect, useMemo, useState } from 'react';
import { buildBackup, hasChanges, parseBackup, planImport, BackupError, SECTIONS, type Backup, type Current, type SectionId } from '../api/backupModel';
import { customTemplates, reloadCustom, saveCustomTemplate, TEMPLATES_DIR } from '../api/customTemplates';
import { errorText } from '../api/engine';
import { saveExport, EXPORT_DIR } from '../api/exports';
import { parseCustomFile, templateFileText } from '../api/templateModel';
import { t } from '../i18n';
import { Badge, Button, Card, Checkbox, Icon, Textarea, toast } from '../kit';
import { ensureFile, setFile, useFile } from '../settings';
import { FilePicker } from '../ui/FilePicker';
import { PageHeader } from '../ui/PageHeader';
import { Hint } from './create/parts';
import { JsonDialog } from './templates/JsonDialog';

/** Reads everything a backup holds, from the plugin's files and the shared templates folder. */
async function readCurrent(): Promise<Current> {
  const [registries, alerts, autoupdate, sources, settings] = await Promise.all([ensureFile('registries'), ensureFile('alerts'), ensureFile('autoupdate'), ensureFile('templates-sources'), ensureFile('settings')]);
  await reloadCustom();
  return {
    registries: registries.registries ?? [],
    customTemplates: customTemplates().filter((x) => x.custom?.file).map((x) => ({ file: x.custom!.file, doc: JSON.parse(templateFileText(x)) })),
    templateSources: sources.sources ?? [],
    alertRules: alerts.rules ?? [],
    autoUpdate: autoupdate.config,
    preferences: settings,
  };
}

const stamp = (d = new Date()): string => d.toISOString().slice(0, 10).replace(/-/g, '');

/** Settings: back up and restore everything the plugin keeps (design: one JSON file, versioned). */
export function SettingsPage() {
  return (
    <>
      <PageHeader icon="cog" title={t('nav.settings')} subtitle={t('backup.sub')} />
      <div className="dk-bk">
        <ExportCard />
        <ImportCard />
      </div>
    </>
  );
}

function ExportCard() {
  const [regs] = useFile('registries');
  const [alerts] = useFile('alerts');
  const [sources] = useFile('templates-sources');
  const [au] = useFile('autoupdate');
  const [custom, setCustom] = useState<number | null>(null);
  const [leaveOut, setLeaveOut] = useState(true);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ text: string; file: string; path: string } | null>(null);
  useEffect(() => {
    void reloadCustom().then(() => setCustom(customTemplates().length), () => setCustom(0));
  }, []);
  const withPasswords = regs.registries.filter((r) => r.password).length;

  const run = async () => {
    setBusy(true);
    try {
      const cur = await readCurrent();
      const text = JSON.stringify(buildBackup(cur, { passwords: !leaveOut }), null, 2) + '\n';
      const file = `ervisio-docker-settings-${stamp()}.json`;
      const path = await saveExport(file, text);
      setOut({ text, file, path });
    } catch (e) {
      toast.err(t('backup.exportFail'), errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const rows: [string, string][] = [
    [t('backup.sec.registries'), String(regs.registries.length)],
    [t('backup.sec.customTemplates'), custom === null ? '…' : String(custom)],
    [t('backup.sec.templateSources'), String(sources.sources.length)],
    [t('backup.sec.alertRules'), String(alerts.rules.length)],
    [t('backup.sec.autoUpdate'), au.config.enabled ? t('backup.on') : t('backup.off')],
    [t('backup.sec.preferences'), t('backup.always')],
  ];

  return (
    <Card title={t('backup.export.title')} icon="download">
      <p className="dk-muted dk-bk-p">{t('backup.export.text')}</p>
      <dl className="dk-cr-kv dk-bk-kv">
        {rows.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <p className="dk-muted dk-bk-p">{t('backup.export.notIncluded')}</p>
      {withPasswords > 0 && (
        <>
          <Checkbox checked={leaveOut} onChange={setLeaveOut} label={t('backup.export.leaveOut', { n: withPasswords })} />
          {!leaveOut && <Hint tone="warn" icon="alert">{t('backup.export.warn')}</Hint>}
        </>
      )}
      <div className="dk-cr-row">
        <Button variant="primary" icon="download" loading={busy} disabled={busy} onClick={() => void run()}>{t('backup.export.button')}</Button>
      </div>
      <p className="dk-muted dk-bk-p">{t('backup.export.where', { dir: EXPORT_DIR })}</p>
      {out && (
        <JsonDialog open onClose={() => setOut(null)} title={t('backup.export.done')} text={out.text} file={out.file} savedPath={out.path}>
          {!leaveOut && withPasswords > 0 && <Hint tone="warn" icon="alert">{t('backup.export.warn')}</Hint>}
        </JsonDialog>
      )}
    </Card>
  );
}

function ImportCard() {
  const [text, setText] = useState('');
  const [cur, setCur] = useState<Current | null>(null);
  const [picked, setPicked] = useState<Set<SectionId>>(new Set(SECTIONS));
  const [busy, setBusy] = useState(false);

  const parsed = useMemo((): { backup?: Backup; error?: string } => {
    if (!text.trim()) return {};
    try {
      return { backup: parseBackup(text) };
    } catch (e) {
      return { error: e instanceof BackupError ? t(e.key, e.vars) : (e as Error).message };
    }
  }, [text]);

  const load = (txt: string) => {
    setText(txt);
    setPicked(new Set(SECTIONS));
    void readCurrent().then(setCur, (e) => toast.err(t('backup.import.readFail'), errorText(e)));
  };

  const result = useMemo(() => (parsed.backup && cur ? planImport(parsed.backup, cur, SECTIONS.filter((s) => picked.has(s))) : null), [parsed.backup, cur, picked]);

  const apply = async () => {
    if (!result || !cur) return;
    setBusy(true);
    const m = result.merged;
    // Only what changes is written: a section with nothing new leaves its file alone.
    const changes = (id: SectionId): boolean => picked.has(id) && result.plan.some((x) => x.id === id && x.added + x.replaced > 0);
    try {
      if (changes('registries')) await setFile('registries', { registries: m.registries });
      if (changes('templateSources')) await setFile('templates-sources', { sources: m.templateSources });
      if (changes('alertRules')) await setFile('alerts', { rules: m.alertRules });
      if (changes('autoUpdate')) await setFile('autoupdate', { config: m.autoUpdate });
      if (changes('preferences')) await setFile('settings', m.preferences);
      if (changes('customTemplates')) {
        const have = new Map(cur.customTemplates.map((x) => [x.file, JSON.stringify(x.doc)]));
        for (const tpl of m.customTemplates) {
          if (have.get(tpl.file) === JSON.stringify(tpl.doc)) continue;
          await saveCustomTemplate(parseCustomFile(tpl.file, JSON.stringify(tpl.doc)), tpl.file);
        }
      }
      toast.ok(t('backup.import.done'));
      setText('');
      setCur(null);
    } catch (e) {
      toast.err(t('backup.import.fail'), errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const b = parsed.backup;
  return (
    <Card title={t('backup.import.title')} icon="upload">
      <p className="dk-muted dk-bk-p">{t('backup.import.text')}</p>
      <Textarea mono rows={6} value={text} onChange={(e) => load(e.target.value)} placeholder='{ "format": "ervisio-docker-settings", "version": 1, … }' aria-label={t('backup.import.title')} spellCheck={false} />
      <div className="dk-cr-row">
        <FilePicker label={t('backup.import.choose')} accept=".json,application/json" variant="secondary" size="md" onText={(txt) => load(txt)} onError={() => toast.err(t('backup.import.readFail'))} />
      </div>
      {parsed.error && <Hint tone="err" icon="alert">{parsed.error}</Hint>}
      {b && (
        <>
          <p className="dk-muted dk-bk-p">{t('backup.import.from', { version: b.version, date: b.exportedAt ? new Date(b.exportedAt).toLocaleString() : '?' })}</p>
          {!b.includesPasswords && b.registries.length > 0 && <Hint tone="muted" icon="info">{t('backup.import.noPasswords')}</Hint>}
          {!result ? <p className="dk-muted">{t('common.loading')}</p> : (
            <ul className="dk-bk-plan" aria-label={t('backup.import.preview')}>
              {result.plan.map((p) => (
                <li key={p.id}>
                  <Checkbox checked={picked.has(p.id)} disabled={p.total === 0} onChange={(on) => setPicked((s) => { const n = new Set(s); if (on) n.add(p.id); else n.delete(p.id); return n; })} label={t(`backup.sec.${p.id}`)} />
                  <span className="dk-bk-n">
                    {p.total === 0 ? <span className="dk-muted">{t('backup.import.none')}</span> : !picked.has(p.id) ? <span className="dk-muted">{t('backup.import.skipped')}</span> : (
                      <>
                        {p.added > 0 && <Badge tone="ok">{t('backup.import.added', { n: p.added })}</Badge>}
                        {p.replaced > 0 && <Badge tone="warn">{t('backup.import.replaced', { n: p.replaced })}</Badge>}
                        {p.unchanged > 0 && <Badge tone="neutral">{t('backup.import.unchanged', { n: p.unchanged })}</Badge>}
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {result && picked.has('customTemplates') && result.plan.find((p) => p.id === 'customTemplates')!.added + result.plan.find((p) => p.id === 'customTemplates')!.replaced > 0 && <Hint tone="muted" icon="info">{t('backup.import.templatesNote', { dir: TEMPLATES_DIR })}</Hint>}
          {result && picked.has('autoUpdate') && result.plan.find((p) => p.id === 'autoUpdate')!.replaced > 0 && <Hint tone="muted" icon="info">{t('backup.import.autoNote')}</Hint>}
          <div className="dk-cr-row">
            <Button variant="primary" icon="upload" loading={busy} disabled={busy || !result || !hasChanges(result.plan)} onClick={() => void apply()}>{t('backup.import.button')}</Button>
            <Button variant="ghost" onClick={() => { setText(''); setCur(null); }}>{t('common.cancel')}</Button>
            {result && !hasChanges(result.plan) && <span className="dk-muted"><Icon name="check" size={13} /> {t('backup.import.nothing')}</span>}
          </div>
        </>
      )}
    </Card>
  );
}
