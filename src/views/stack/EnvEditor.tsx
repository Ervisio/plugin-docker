import { useEffect, useMemo, useRef, useState } from 'react';
import { ENV_NAME, envHints, isSecretName, mergeEnv, newVar, parseRows, rowsToText, type EnvRow } from '../../api/dotenv';
import { t, tn } from '../../i18n';
import { Button, Checkbox, Icon, IconButton, Input, Switch, Textarea } from '../../kit';
import { FilePicker } from '../../ui/FilePicker';
import { Hint } from '../create/parts';
import { CodeEditor } from './CodeEditor';
import type { Issue } from './validate';

/**
 * The .env of a stack. One string is the source of truth (the parent's `value`, the same text the stack page saves
 * to /opt/stacks/<name>/.env). The table and the raw editor are two views of that text: the table changes only the
 * lines you touch and keeps comments and other formatting.
 */
export function EnvEditor({ value, onChange, compose, advanced, onAdvanced, issues, minLines = 12, disabled }: {
  value: string;
  onChange(v: string): void;
  /** The compose text, for the hints about ${VARIABLES}. */
  compose: string;
  advanced: boolean;
  onAdvanced(on: boolean): void;
  issues: Issue[];
  minLines?: number;
  disabled?: boolean;
}) {
  const [rows, setRows] = useState<EnvRow[]>(() => parseRows(value).rows);
  const last = useRef(value);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [paste, setPaste] = useState('');
  const [replace, setReplace] = useState(true);
  const [focusId, setFocusId] = useState('');

  // The text changed from outside (raw editor, reload, import): read it again. Our own commits are skipped.
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setRows(parseRows(value).rows);
    }
  }, [value]);

  const commit = (next: EnvRow[]) => {
    setRows(next);
    const text = rowsToText(next);
    last.current = text;
    onChange(text);
  };

  const vars = useMemo(() => rows.filter((r) => r.kind === 'var'), [rows]);
  const hints = useMemo(() => envHints(compose, value), [compose, value]);
  const nameProblem = (r: EnvRow): string | undefined => {
    if (!r.key.trim()) return undefined;
    if (!ENV_NAME.test(r.key)) return t('stacks.env.badName');
    const first = vars.find((x) => x.key === r.key);
    return first && first.id !== r.id ? t('stacks.env.dupName') : undefined;
  };
  const errors = issues.filter((i) => i.level === 'error').length;

  const set = (id: string, p: Partial<EnvRow>) => commit(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const remove = (id: string) => commit(rows.filter((r) => r.id !== id));
  const move = (id: string, dir: -1 | 1) => {
    const at = rows.findIndex((r) => r.id === id);
    let to = at + dir;
    while (to >= 0 && to < rows.length && rows[to].kind !== 'var') to += dir;
    if (to < 0 || to >= rows.length) return;
    const next = rows.slice();
    [next[at], next[to]] = [next[to], next[at]];
    commit(next);
  };
  const add = (key = '') => {
    const r = newVar(key, '');
    setFocusId(r.id);
    commit([...rows, r]);
  };

  const parsedPaste = useMemo(() => parseRows(paste), [paste]);
  const incoming = parsedPaste.rows.filter((r) => r.kind === 'var').map((r) => ({ key: r.key, value: r.value }));
  const preview = useMemo(() => mergeEnv(value, incoming, replace), [value, incoming, replace]);
  const applyImport = () => {
    commit(parseRows(preview.text).rows);
    setPaste('');
    setImporting(false);
  };

  const toggle = (id: string) => setShown((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const bar = (
    <div className="dk-ev-bar">
      <b>{tn('stacks.env.count', { n: vars.length })}</b>
      <span className="dk-ev-sp" />
      {!advanced && <Button size="sm" variant="ghost" icon="upload" disabled={disabled} onClick={() => setImporting((v) => !v)}>{t('stacks.env.import')}</Button>}
      <Switch checked={advanced} onChange={onAdvanced} label={t('stacks.env.advanced')} />
    </div>
  );

  const importer = importing && !advanced && (
    <div className="dk-ev-imp">
      <Textarea mono rows={7} value={paste} onChange={(e) => setPaste(e.target.value)} label={t('stacks.env.pasteLabel')} placeholder={'DB_HOST=db\nDB_PASSWORD=secret\n# comments are kept out'} spellCheck={false} />
      <div className="dk-cr-row">
        <FilePicker label={t('stacks.env.chooseFile')} accept=".env,text/plain,*/*" onText={(txt) => setPaste(txt)} onError={() => undefined} />
        <Checkbox checked={replace} onChange={setReplace} label={t('stacks.env.replace')} />
      </div>
      {paste.trim() && (
        <Hint tone={parsedPaste.issues.some((i) => i.level === 'error') ? 'warn' : 'ok'} icon={parsedPaste.issues.some((i) => i.level === 'error') ? 'alert' : 'check'}>
          {t('stacks.env.preview', { added: preview.added, replaced: preview.replaced, kept: preview.kept })}
          {parsedPaste.issues.some((i) => i.level === 'error') ? ' ' + tn('stacks.env.previewSkipped', { n: parsedPaste.issues.filter((i) => i.level === 'error').length }) : ''}
        </Hint>
      )}
      <div className="dk-cr-row">
        <Button size="sm" variant="primary" disabled={!incoming.length} onClick={applyImport}>{t('stacks.env.apply')}</Button>
        <Button size="sm" onClick={() => { setImporting(false); setPaste(''); }}>{t('common.cancel')}</Button>
      </div>
    </div>
  );

  if (advanced) {
    return (
      <div className="dk-ev">
        {bar}
        <CodeEditor value={value} onChange={onChange} lang="env" issues={issues} label=".env" minLines={minLines} readOnly={disabled} />
        <p className="dk-muted dk-ev-note">{t('stacks.envHint')}</p>
      </div>
    );
  }

  return (
    <div className="dk-ev">
      {bar}
      {importer}
      {vars.length === 0 && !importing && <p className="dk-muted dk-cr-empty">{t('stacks.env.empty')}</p>}
      <div className="dk-ev-rows">
        {vars.map((r, i) => {
          const secret = isSecretName(r.key);
          const hide = secret && !shown.has(r.id);
          const problem = nameProblem(r);
          const multi = r.value.includes('\n');
          return (
            <div className="dk-ev-row" key={r.id}>
              <div className="dk-ev-mv">
                <IconButton icon="chevronup" size="sm" label={t('stacks.env.up')} disabled={i === 0 || disabled} onClick={() => move(r.id, -1)} />
                <IconButton icon="chevron" size="sm" label={t('stacks.env.down')} disabled={i === vars.length - 1 || disabled} onClick={() => move(r.id, 1)} />
              </div>
              <Input mono compact value={r.key} placeholder="NAME" aria-label={t('stacks.env.name')} error={problem} onChange={(e) => set(r.id, { key: e.target.value })} fieldClassName="dk-ev-k" spellCheck={false} autoCapitalize="off" autoFocus={r.id === focusId} disabled={disabled} />
              {multi && !hide ? (
                <Textarea mono rows={3} value={r.value} aria-label={t('stacks.env.value')} onChange={(e) => set(r.id, { value: e.target.value })} spellCheck={false} />
              ) : (
                <Input
                  mono
                  compact
                  type={hide ? 'password' : 'text'}
                  value={r.value}
                  placeholder={t('stacks.env.value')}
                  aria-label={t('stacks.env.value')}
                  onChange={(e) => set(r.id, { value: e.target.value })}
                  fieldClassName="dk-ev-v"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                  end={secret ? <IconButton icon={hide ? 'eye' : 'eyeoff'} size="sm" label={hide ? t('create.env.show') : t('create.env.hide')} onClick={() => toggle(r.id)} /> : undefined}
                />
              )}
              <IconButton icon="trash" label={t('common.remove')} disabled={disabled} onClick={() => remove(r.id)} />
            </div>
          );
        })}
      </div>
      <div className="dk-cr-row">
        <Button className="dk-cr-add" variant="ghost" size="sm" icon="plus" disabled={disabled} onClick={() => add()}>{t('stacks.env.add')}</Button>
      </div>
      {errors > 0 && (
        <div className="dk-ev-warn" role="alert">
          <Icon name="alert" size={14} />
          <span>{tn('stacks.env.cantShow', { n: errors })}</span>
          <Button size="sm" onClick={() => onAdvanced(true)}>{t('stacks.env.openAdvanced')}</Button>
        </div>
      )}
      {hints.missing.length > 0 && (
        <div className="dk-ev-hint dk-ev-hint--warn">
          <b><Icon name="alert" size={14} /> {t('stacks.env.missing')}</b>
          <div className="dk-ev-chips">
            {hints.missing.map((m) => (
              <button type="button" className="dk-ev-chip" key={m.name} disabled={disabled} onClick={() => add(m.name)} title={t('stacks.env.addVar', { name: m.name })}>
                <Icon name="plus" size={12} />{m.name}{m.required ? <i>{t('stacks.env.required')}</i> : null}
              </button>
            ))}
          </div>
        </div>
      )}
      {hints.unused.length > 0 && (
        <div className="dk-ev-hint">
          <b>{t('stacks.env.unused')}</b>
          <div className="dk-ev-chips">{hints.unused.map((n) => <span className="dk-ev-chip dk-ev-chip--n" key={n}>{n}</span>)}</div>
        </div>
      )}
      {hints.wholesale && <p className="dk-muted dk-ev-note">{t('stacks.env.wholesale')}</p>}
      <p className="dk-muted dk-ev-note">{t('stacks.env.where')}</p>
    </div>
  );
}
