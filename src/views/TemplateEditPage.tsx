import { useMemo, useState } from 'react';
import { saveCustomTemplate, TEMPLATES_DIR, useCustomTemplates } from '../api/customTemplates';
import { errorText } from '../api/engine';
import { composeRefs, envFromPairs } from '../api/dotenv';
import { emptyForm, formFromTemplate, newEnvForm, templateFromForm, type EnvForm, type TemplateForm } from '../api/templateForm';
import { templateFileText, type Template } from '../api/templateModel';
import { t } from '../i18n';
import { Button, Checkbox, EmptyState, Icon, IconButton, Input, Segmented, Select, Skeleton, Switch, Textarea, toast } from '../kit';
import { back, navigate } from '../router';
import { PageHeader } from '../ui/PageHeader';
import { Hint, Section } from './create/parts';
import { CodeEditor } from './stack/CodeEditor';
import { validateCompose } from './stack/validate';
import { CustomMenu } from './templates/CustomActions';
import { JsonDialog } from './templates/JsonDialog';

/** Create or edit a custom template. With `seed` the form starts from a stack or container ("Save as template"). */
export function TemplateEditPage({ id, seed }: { id?: string; seed?: Template }) {
  const custom = useCustomTemplates();
  const existing = id ? custom.templates.find((x) => x.id === id) : undefined;
  if (id && !existing) {
    return (
      <>
        <PageHeader icon="store" title={t('templates.edit.title')} back />
        {!custom.loaded ? <Skeleton height={260} style={{ borderRadius: 18 }} /> : <EmptyState icon="search" title={t('templates.missing.title')} text={t('templates.missing.text')} action={<Button onClick={() => navigate({ view: 'templates' }, { root: true })}>{t('templates.backToStore')}</Button>} />}
      </>
    );
  }
  return <Editor key={id ?? 'new'} existing={existing} seed={seed} />;
}

const KINDS: EnvForm['type'][] = ['text', 'password', 'port', 'path', 'bool'];
const RESTARTS = ['no', 'always', 'unless-stopped', 'on-failure'];

function Editor({ existing, seed }: { existing?: Template; seed?: Template }) {
  const start = existing ?? seed;
  const [form, setForm] = useState<TemplateForm>(() => (start ? formFromTemplate(start) : emptyForm('stack')));
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const patch = (p: Partial<TemplateForm>) => setForm((f) => ({ ...f, ...p }));
  const setEnv = (idv: string, p: Partial<EnvForm>) => setForm((f) => ({ ...f, env: f.env.map((e) => (e.id === idv ? { ...e, ...p } : e)) }));

  const result = useMemo(() => templateFromForm(form, existing), [form, existing]);
  const problem = (field: string): string | undefined => {
    const p = result.problems.find((x) => x.field === field);
    return showErrors && p ? t(p.key, p.vars) : undefined;
  };
  const compose = useMemo(() => (form.type === 'stack' ? validateCompose(form.compose, envFromPairs(form.env.map((e) => ({ key: e.name, value: e.value })))) : null), [form.type, form.compose, form.env]);
  const composeErrors = compose?.errors ?? 0;
  const refs = useMemo(() => (form.type === 'stack' ? composeRefs(form.compose).filter((r) => !form.env.some((e) => e.name === r.name)) : []), [form.type, form.compose, form.env]);

  const save = async () => {
    if (result.problems.length || composeErrors) {
      setShowErrors(true);
      return;
    }
    setBusy(true);
    try {
      const saved = await saveCustomTemplate(result.template!, existing?.custom?.file);
      toast.ok(t('templates.custom.saved', { name: saved.name }));
      navigate({ view: 'template', id: saved.id }, { replace: true });
    } catch (e) {
      toast.err(t('templates.custom.saveFail'), errorText(e));
      setBusy(false);
    }
  };

  const addEnv = (name = '', ask = false) => {
    const e = newEnvForm({ name, ask, label: name, type: /pass|secret|token|key/i.test(name) ? 'password' : 'text', generate: /pass|secret|token|key/i.test(name) });
    setForm((f) => ({ ...f, env: [...f.env, e] }));
    if (ask) setOpen((s) => new Set(s).add(e.id));
  };
  const toggleOpen = (idv: string) => setOpen((s) => { const n = new Set(s); if (n.has(idv)) n.delete(idv); else n.add(idv); return n; });

  const file = existing?.custom?.file;
  const dest = file ? `${TEMPLATES_DIR}/${file}.json` : `${TEMPLATES_DIR}/<name>.json`;

  return (
    <>
      <PageHeader
        icon="store"
        title={existing ? t('templates.edit.editing', { name: existing.name }) : t('templates.edit.title')}
        subtitle={<span className="dk-sk-path">{dest}</span>}
        back
        actions={
          <>
            {existing && <CustomMenu tpl={existing} onDeleted={() => navigate({ view: 'templates' }, { root: true })} />}
            <Button icon="code" onClick={() => setExporting(true)} disabled={!result.template}>{t('templates.custom.export')}</Button>
            <Button variant="primary" icon="download" loading={busy} disabled={busy} onClick={() => void save()}>{t('templates.edit.save')}</Button>
          </>
        }
      />
      <div className="dk-te">
        <Hint tone="muted" icon="info">{t('templates.custom.where', { dir: TEMPLATES_DIR })}</Hint>
        {seed && !existing && <Hint tone="ok" icon="check">{t('templates.edit.seeded')}</Hint>}

        <Section title={t('templates.edit.about')}>
          <div className="dk-cr-g2">
            <Input label={t('templates.edit.name')} value={form.name} onChange={(e) => patch({ name: e.target.value })} error={problem('name')} maxLength={80} autoFocus={!start} />
            <Input label={t('templates.edit.categories')} value={form.categories} onChange={(e) => patch({ categories: e.target.value })} hint={t('templates.edit.categoriesHint')} placeholder="Web, Blog" />
          </div>
          <Input label={t('templates.edit.description')} value={form.description} onChange={(e) => patch({ description: e.target.value })} />
          <div className="dk-cr-g2">
            <Input label={t('templates.edit.logo')} mono value={form.logo} onChange={(e) => patch({ logo: e.target.value })} error={problem('logo')} hint={t('templates.edit.logoHint')} placeholder="https://…/logo.png" spellCheck={false} />
            <Input label={t('templates.edit.note')} value={form.note} onChange={(e) => patch({ note: e.target.value })} hint={t('templates.edit.noteHint')} />
          </div>
          <div className="dk-te-kind">
            <span className="dk-muted">{t('templates.edit.kind')}</span>
            <Segmented
              aria-label={t('templates.edit.kind')}
              value={form.type}
              onChange={(v) => setForm((f) => ({ ...f, type: v as 'stack' | 'container', compose: v === 'stack' && !f.compose.trim() ? emptyForm('stack').compose : f.compose }))}
              options={[{ value: 'stack', label: t('templates.type.stack'), icon: 'layers' }, { value: 'container', label: t('templates.type.container'), icon: 'box' }]}
            />
          </div>
        </Section>

        {form.type === 'stack' ? (
          <Section title="compose.yaml" note={t('templates.edit.composeNote')}>
            <div className={compose && compose.errors ? 'dk-cr-bad dk-te-ed' : 'dk-te-ed'}>
              <CodeEditor value={form.compose} onChange={(v) => patch({ compose: v })} lang="yaml" issues={compose?.issues ?? []} label="compose.yaml" minLines={14} />
            </div>
            {showErrors && problem('compose') && <Hint tone="err" icon="alert">{problem('compose')}</Hint>}
            {compose && compose.errors > 0 && <Hint tone="err" icon="alert">{t('stacks.valid.errors', { n: compose.errors })}</Hint>}
            {compose && compose.errors === 0 && form.compose.trim() && <Hint tone="ok" icon="check">{t('stacks.valid.ok')}</Hint>}
          </Section>
        ) : (
          <Section title={t('templates.edit.container')}>
            <div className="dk-cr-g2">
              <Input label={t('create.image')} mono value={form.image} onChange={(e) => patch({ image: e.target.value })} error={problem('image')} placeholder="nginx:1.27" spellCheck={false} />
              <Select label={t('create.restart')} value={form.restart} onChange={(v) => patch({ restart: v })} options={RESTARTS.map((r) => ({ value: r, label: r }))} />
            </div>
            <div className="dk-cr-g2">
              <Textarea label={t('templates.edit.ports')} mono rows={3} value={form.ports} onChange={(e) => patch({ ports: e.target.value })} error={problem('ports')} hint={t('templates.edit.portsHint')} placeholder={'8080:80/tcp\n${HTTP_PORT}:80'} spellCheck={false} />
              <Textarea label={t('templates.edit.volumes')} mono rows={3} value={form.volumes} onChange={(e) => patch({ volumes: e.target.value })} error={problem('volumes')} hint={t('templates.edit.volumesHint')} placeholder={'/srv/www:/usr/share/nginx/html:ro\n/data'} spellCheck={false} />
            </div>
            <div className="dk-cr-g2">
              <Input label={t('create.adv.command')} mono value={form.command} onChange={(e) => patch({ command: e.target.value })} spellCheck={false} />
              <Input label={t('create.hostname')} mono value={form.hostname} onChange={(e) => patch({ hostname: e.target.value })} spellCheck={false} />
            </div>
            <div className="dk-cr-g2">
              <Input label={t('create.network')} mono value={form.network} onChange={(e) => patch({ network: e.target.value })} hint={t('templates.edit.networkHint')} spellCheck={false} />
              <Textarea label={t('templates.edit.labels')} mono rows={2} value={form.labels} onChange={(e) => patch({ labels: e.target.value })} error={problem('labels')} hint={t('templates.edit.labelsHint')} spellCheck={false} />
            </div>
            <Switch checked={form.privileged} onChange={(v) => patch({ privileged: v })} label={t('templates.edit.privileged')} />
          </Section>
        )}

        <Section title={t('templates.edit.env')} note={form.type === 'stack' ? t('templates.edit.envNoteStack') : t('templates.edit.envNoteContainer')}>
          {form.env.length === 0 && <p className="dk-muted dk-cr-empty">{t('templates.edit.envEmpty')}</p>}
          {form.env.map((e) => {
            const err = problem(`env:${e.id}`);
            const expanded = e.ask && open.has(e.id);
            return (
              <div className="dk-te-env" key={e.id}>
                <div className="dk-te-envr">
                  <Input mono compact value={e.name} placeholder="NAME" aria-label={t('stacks.env.name')} onChange={(ev) => setEnv(e.id, { name: ev.target.value })} fieldClassName="dk-te-k" error={err} spellCheck={false} autoCapitalize="off" />
                  <Input mono compact value={e.value} placeholder={e.ask ? t('templates.edit.defaultValue') : t('stacks.env.value')} aria-label={e.ask ? t('templates.edit.defaultValue') : t('stacks.env.value')} type={e.type === 'password' && e.ask ? 'password' : 'text'} onChange={(ev) => setEnv(e.id, { value: ev.target.value })} fieldClassName="dk-te-v" autoComplete="off" spellCheck={false} />
                  <Switch checked={e.ask} onChange={(v) => { setEnv(e.id, { ask: v, label: e.label || e.name }); if (v) setOpen((s) => new Set(s).add(e.id)); }} label={t('templates.edit.ask')} />
                  {e.ask && <IconButton icon={expanded ? 'chevronup' : 'chevron'} label={expanded ? t('templates.edit.lessOpts') : t('templates.edit.moreOpts')} size="sm" onClick={() => toggleOpen(e.id)} />}
                  <IconButton icon="trash" label={t('common.remove')} onClick={() => setForm((f) => ({ ...f, env: f.env.filter((x) => x.id !== e.id) }))} />
                </div>
                {expanded && (
                  <div className="dk-te-more">
                    <div className="dk-cr-g2">
                      <Input label={t('templates.edit.varLabel')} value={e.label} onChange={(ev) => setEnv(e.id, { label: ev.target.value })} />
                      <Select label={t('templates.edit.varKind')} value={e.type} onChange={(v) => setEnv(e.id, { type: v as EnvForm['type'], generate: v === 'password' ? e.generate : false })} options={KINDS.map((k) => ({ value: k, label: t(`templates.edit.kind.${k}`) }))} />
                    </div>
                    <Input label={t('templates.edit.varHint')} value={e.hint} onChange={(ev) => setEnv(e.id, { hint: ev.target.value })} />
                    <Textarea label={t('templates.edit.varOptions')} mono rows={2} value={e.options} onChange={(ev) => setEnv(e.id, { options: ev.target.value })} hint={t('templates.edit.varOptionsHint')} placeholder={'Small=s\nLarge=l'} spellCheck={false} />
                    <div className="dk-cr-row">
                      <Checkbox checked={e.required} onChange={(v) => setEnv(e.id, { required: v })} label={t('templates.edit.varRequired')} />
                      {e.type === 'password' && <Checkbox checked={e.generate} onChange={(v) => setEnv(e.id, { generate: v })} label={t('templates.edit.varGenerate')} />}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <div className="dk-cr-row">
            <Button className="dk-cr-add" variant="ghost" size="sm" icon="plus" onClick={() => addEnv()}>{t('templates.edit.addEnv')}</Button>
          </div>
          {refs.length > 0 && (
            <div className="dk-ev-hint dk-ev-hint--warn">
              <b><Icon name="alert" size={14} /> {t('templates.edit.refs')}</b>
              <div className="dk-ev-chips">
                {refs.map((r) => (
                  <button type="button" className="dk-ev-chip" key={r.name} onClick={() => addEnv(r.name, true)}><Icon name="plus" size={12} />{r.name}</button>
                ))}
              </div>
            </div>
          )}
        </Section>

        <div className="dk-cr-nav">
          <span className="dk-cr-sp" />
          <Button variant="ghost" onClick={back}>{t('common.cancel')}</Button>
          <Button variant="primary" icon="download" loading={busy} disabled={busy} onClick={() => void save()}>{t('templates.edit.save')}</Button>
        </div>
        {showErrors && (result.problems.length > 0 || composeErrors > 0) && <Hint tone="err" icon="alert">{t('templates.edit.fixFirst')}</Hint>}
      </div>
      {result.template && <JsonDialog open={exporting} onClose={() => setExporting(false)} title={t('templates.custom.exportTitle', { name: result.template.name })} text={templateFileText(result.template)} file={`template-${existing?.custom?.file ?? 'new'}.json`}><p className="dk-muted">{t('templates.custom.exportNote')}</p></JsonDialog>}
    </>
  );
}
