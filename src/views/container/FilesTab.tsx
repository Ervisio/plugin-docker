import { useCallback, useEffect, useRef, useState } from 'react';
import { FILE_LIMIT, UPLOAD_LIMIT, FsError, joinPath, listDir, makeDir, normalizePath, parentOf, readFile, removePath, saveBlob, validName, writeFile, type FsEntry, type Listing } from '../../api/files';
import { classify } from '../../api/engine';
import { formatBytes } from '../../api/format';
import { t } from '../../i18n';
import { Button, Dialog, EmptyState, Icon, IconButton, Input, Skeleton, toast } from '../../kit';
import { DataTable, type DataColumn } from '../../ui/DataTable';
import { ConfirmBox } from './ConfirmBox';
import { copyText } from './util';

const PREVIEW_CHARS = 200000;

/** The text of a file when it looks like text (UTF-8, no NUL bytes), or undefined. */
function asText(data: Uint8Array): string | undefined {
  if (data.subarray(0, 8192).includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

const when = (ms: number): string => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–');

function failText(e: unknown, path: string): string {
  if (e instanceof FsError) {
    switch (e.code) {
      case 'notfound': return t('container.files.err.notfound', { path });
      case 'notdir': return t('container.files.err.notdir', { path });
      case 'denied': return t('container.files.err.denied', { path });
      case 'readonly': return t('container.files.err.readonly');
      case 'toolarge': return t('container.files.err.toolarge', { path });
      case 'noexec': return t('container.files.err.noexec');
      default: return e.message;
    }
  }
  return classify(e).message;
}

/** A file browser for the inside of a container. Reads and writes through the Engine API, so it also works when the container is stopped. */
export function FilesTab({ id, running }: { id: string; running: boolean }) {
  const [path, setPath] = useState('/');
  const [draft, setDraft] = useState('/');
  const [list, setList] = useState<Listing | undefined>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>('');
  const [mkdir, setMkdir] = useState(false);
  const [folder, setFolder] = useState('');
  const [mkErr, setMkErr] = useState('');
  const [del, setDel] = useState<FsEntry | undefined>();
  const [view, setView] = useState<{ entry: FsEntry; data: Uint8Array; at: string } | undefined>();
  const [over, setOver] = useState<{ file: File; data: Uint8Array } | undefined>();
  const seq = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (to: string) => {
      const n = ++seq.current;
      setLoading(true);
      try {
        const l = await listDir(id, to, running);
        if (n !== seq.current) return;
        setList(l);
        setPath(l.path);
        setDraft(l.path);
        setError('');
      } catch (e) {
        if (n !== seq.current) return;
        setPath(normalizePath(to));
        setError(failText(e, to));
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    [id, running],
  );
  useEffect(() => {
    void load(path);
    // Reload when the container starts or stops (the way of listing changes), not on every path change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, running]);

  const go = (to: string) => {
    const p = normalizePath(to);
    setDraft(p);
    void load(p);
  };
  const open = (e: FsEntry) => {
    if (e.kind === 'dir') return go(joinPath(path, e.name));
    if (e.kind === 'link' && e.target) {
      const to = normalizePath(e.target.startsWith('/') ? e.target : joinPath(path, e.target));
      // A link can point to a folder or to a file: try the folder first.
      void listDir(id, to, running).then(
        () => go(to),
        (err) => {
          if (err instanceof FsError && err.code === 'notdir') void preview({ ...e, name: to.split('/').pop() ?? e.name, kind: 'file', size: 0 }, to);
          else toast.err(t('container.files.errTitle'), failText(err, to));
        },
      );
      return;
    }
    void preview(e);
  };

  const preview = async (e: FsEntry, at?: string) => {
    if (e.kind !== 'file') return toast.info(t('container.files.notFile', { name: e.name }));
    if (e.size > FILE_LIMIT) return toast.err(t('container.files.tooBig', { name: e.name, size: formatBytes(e.size) }), t('container.files.limitText'));
    setBusy(`d:${e.name}`);
    try {
      const full = at ?? joinPath(path, e.name);
      setView({ entry: e, data: await readFile(id, full), at: full });
    } catch (err) {
      toast.err(t('container.files.downloadFail', { name: e.name }), failText(err, at ?? joinPath(path, e.name)));
    } finally {
      setBusy('');
    }
  };

  const download = async (e: FsEntry, known?: Uint8Array) => {
    const full = joinPath(path, e.name);
    if (e.kind !== 'file') {
      toast.info(t('container.files.notFile', { name: e.name }));
      return;
    }
    if (e.size > FILE_LIMIT) {
      toast.err(t('container.files.tooBig', { name: e.name, size: formatBytes(e.size) }), t('container.files.limitText'));
      return;
    }
    setBusy(`d:${e.name}`);
    try {
      const data = known ?? (await readFile(id, full));
      if (saveBlob(e.name, data)) toast.ok(t('container.files.downloaded', { name: e.name, size: formatBytes(data.length) }));
      else toast.err(t('container.files.saveFail', { name: e.name }));
    } catch (err) {
      toast.err(t('container.files.downloadFail', { name: e.name }), failText(err, full));
    } finally {
      setBusy('');
    }
  };

  const doUpload = async (file: File, data: Uint8Array) => {
    setBusy('upload');
    try {
      await writeFile(id, path, file.name, data);
      toast.ok(t('container.files.uploaded', { name: file.name, path }));
      await load(path);
    } catch (err) {
      toast.err(t('container.files.uploadFail', { name: file.name }), failText(err, path));
    } finally {
      setBusy('');
    }
  };
  const pick = async (file: File | undefined) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    if (!validName(file.name)) {
      toast.err(t('container.files.nameBad'));
      return;
    }
    if (file.size > UPLOAD_LIMIT) {
      toast.err(t('container.files.tooBig', { name: file.name, size: formatBytes(file.size) }), t('container.files.limitUp', { size: formatBytes(UPLOAD_LIMIT) }));
      return;
    }
    const data = new Uint8Array(await file.arrayBuffer());
    if (list?.entries.some((x) => x.name === file.name)) setOver({ file, data });
    else await doUpload(file, data);
  };

  const create = async () => {
    const name = folder.trim();
    if (!validName(name)) return setMkErr(t('container.files.nameBad'));
    if (list?.entries.some((x) => x.name === name)) return setMkErr(t('container.files.exists', { name }));
    setBusy('mkdir');
    try {
      await makeDir(id, path, name);
      toast.ok(t('container.files.created', { name }));
      setMkdir(false);
      setFolder('');
      await load(path);
    } catch (err) {
      setMkErr(failText(err, path));
    } finally {
      setBusy('');
    }
  };

  const canDelete = running && list?.via === 'exec';
  const delReason = !running ? t('container.files.del.stopped') : list?.via !== 'exec' ? t('container.files.del.noShell') : '';

  const cols: DataColumn<FsEntry>[] = [
    {
      key: 'name',
      header: t('container.files.name'),
      render: (e) => (
        <span className={`dk-c-fl-name dk-c-fl--${e.kind}`} title={e.target ? `${e.name} → ${e.target}` : e.name}>
          <Icon name={e.kind === 'dir' ? 'files' : e.kind === 'link' ? 'link' : 'file'} size={15} />
          <span className="dk-c-fl-nm">{e.name}</span>
          {e.target && <span className="dk-muted dk-c-fl-tg">→ {e.target}</span>}
        </span>
      ),
    },
    { key: 'size', header: t('container.files.size'), align: 'right', width: 90, render: (e) => (e.kind === 'file' ? formatBytes(e.size) : '–') },
    { key: 'mode', header: t('container.files.mode'), width: 110, hideBelow: 'md', className: 'dk-mono', render: (e) => `${e.kind === 'dir' ? 'd' : e.kind === 'link' ? 'l' : '-'}${e.mode}` },
    { key: 'owner', header: t('container.files.owner'), width: 110, hideBelow: 'md', render: (e) => (e.owner ? `${e.owner}:${e.group}` : '–') },
    { key: 'mtime', header: t('container.files.mtime'), width: 170, hideBelow: 'sm', render: (e) => when(e.mtime) },
    {
      key: 'act',
      width: 84,
      render: (e) => (
        <span className="dk-c-fl-act" onClick={(ev) => ev.stopPropagation()}>
          {e.kind === 'file' && <IconButton icon="download" size="sm" variant="ghost" label={t('container.files.download')} loading={busy === `d:${e.name}`} onClick={() => void download(e)} />}
          <IconButton icon="trash" size="sm" variant="ghost" label={canDelete ? t('container.files.delete') : delReason} disabled={!canDelete} onClick={() => setDel(e)} />
        </span>
      ),
    },
  ];

  return (
    <div className="dk-card dk-c-files">
      <div className="dk-c-fl-bar">
        <IconButton icon="chevronup" label={t('container.files.up')} disabled={path === '/'} onClick={() => go(parentOf(path))} />
        <Input fieldClassName="dk-c-grow" mono compact value={draft} aria-label={t('container.files.path')} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(draft.startsWith('/') ? draft : `/${draft}`); }} spellCheck={false} autoCapitalize="off" />
        <IconButton icon="refresh" label={t('common.refresh')} onClick={() => void load(path)} />
        <Button size="sm" icon="folderplus" onClick={() => { setMkdir(true); setFolder(''); setMkErr(''); }} disabled={!!busy}>{t('container.files.newFolder')}</Button>
        <Button size="sm" icon="upload" loading={busy === 'upload'} onClick={() => fileInput.current?.click()} disabled={!!busy}>{t('container.files.upload')}</Button>
        <input ref={fileInput} type="file" hidden aria-label={t('container.files.upload')} onChange={(e) => void pick(e.target.files?.[0])} />
      </div>

      {!running && <p className="dk-muted dk-c-fl-note"><Icon name="info" size={14} /> {t('container.files.stopped')}</p>}
      {running && list?.via === 'archive' && <p className="dk-muted dk-c-fl-note"><Icon name="info" size={14} /> {t('container.files.noLs')}</p>}
      {list?.cut && <p className="dk-muted dk-c-fl-note"><Icon name="info" size={14} /> {t('container.files.cut')}</p>}

      {error ? (
        <EmptyState icon="files" hue="file" title={t('container.files.errTitle')} text={error} action={<Button icon="refresh" onClick={() => void load(path)}>{t('common.retry')}</Button>} />
      ) : loading && !list ? (
        <Skeleton height={180} style={{ borderRadius: 14 }} />
      ) : (
        <DataTable
          columns={cols}
          rows={list?.entries ?? []}
          rowKey={(e) => e.name}
          onRowClick={open}
          empty={<EmptyState icon="files" hue="file" title={t('container.files.empty')} text={t('container.files.emptyText')} />}
        />
      )}
      <p className="dk-muted dk-c-fl-note">{t('container.files.limit', { down: formatBytes(FILE_LIMIT, 0), up: formatBytes(UPLOAD_LIMIT, 0) })}</p>

      <Dialog
        open={mkdir}
        onClose={() => busy !== 'mkdir' && setMkdir(false)}
        title={t('container.files.newFolder')}
        description={t('container.files.newFolderIn', { path })}
        icon="folderplus"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMkdir(false)} disabled={busy === 'mkdir'}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={busy === 'mkdir'} disabled={!folder.trim()} onClick={() => void create()}>{t('container.files.createFolder')}</Button>
          </>
        }
      >
        <Input label={t('container.files.folderName')} mono autoFocus value={folder} onChange={(e) => { setFolder(e.target.value); setMkErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter' && folder.trim()) void create(); }} error={mkErr || undefined} spellCheck={false} autoComplete="off" />
      </Dialog>

      <Dialog
        open={!!view}
        onClose={() => setView(undefined)}
        title={view?.entry.name ?? ''}
        description={view ? `${view.at} · ${formatBytes(view.data.length)}` : undefined}
        icon="file"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setView(undefined)}>{t('common.close')}</Button>
            {view && asText(view.data) !== undefined && <Button icon="copy" onClick={() => void copyText(asText(view.data) ?? '').then((ok) => (ok ? toast.ok(t('container.files.copied')) : toast.err(t('container.files.copyFail'))))}>{t('container.files.copy')}</Button>}
            <Button variant="primary" icon="download" onClick={() => view && void download(view.entry, view.data)}>{t('container.files.download')}</Button>
          </>
        }
      >
        {view && (asText(view.data) !== undefined ? (
          <>
            <pre className="dk-c-fl-pre" tabIndex={0}>{asText(view.data)!.slice(0, PREVIEW_CHARS) || t('container.files.emptyFile')}</pre>
            {asText(view.data)!.length > PREVIEW_CHARS && <p className="dk-muted dk-c-p">{t('container.files.previewCut')}</p>}
          </>
        ) : (
          <p className="dk-muted dk-c-p">{t('container.files.binary')}</p>
        ))}
      </Dialog>

      <ConfirmBox
        open={!!del}
        onClose={() => setDel(undefined)}
        title={t('container.files.delTitle', { name: del?.name ?? '' })}
        description={del?.kind === 'dir' ? t('container.files.delDir', { path: del ? joinPath(path, del.name) : '' }) : t('container.files.delFile', { path: del ? joinPath(path, del.name) : '' })}
        confirmLabel={t('container.files.deleteBtn')}
        danger
        onConfirm={async () => {
          if (!del) return;
          try {
            await removePath(id, joinPath(path, del.name));
          } catch (e) {
            throw new Error(failText(e, joinPath(path, del.name)));
          }
          toast.ok(t('container.files.deleted', { name: del.name }));
          await load(path);
        }}
      />
      <ConfirmBox
        open={!!over}
        onClose={() => setOver(undefined)}
        title={t('container.files.overTitle', { name: over?.file.name ?? '' })}
        description={t('container.files.overText')}
        confirmLabel={t('container.files.replace')}
        icon="upload"
        onConfirm={async () => {
          if (over) await doUpload(over.file, over.data);
        }}
      />
    </div>
  );
}
