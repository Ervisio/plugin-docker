import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '../api/format';
import { diskUsage, images } from '../api/resources';
import { t, tn } from '../i18n';
import { Button, Checkbox, Icon, Input, Segmented, Textarea, toast } from '../kit';
import { navigate } from '../router';
import { PageHeader } from '../ui/PageHeader';
import { BuildOutput } from './build/BuildOutput';
import { MAX_CONTEXT, MAX_RAW_CONTEXT, parsePairs, runBuild, type BuildOptions, type BuildSource, type BuildState } from './build/build';
import { gzip, packPicked, packTar, pickedFrom, type Picked } from './build/tar';
import { jumpToLine, CodeEditor } from './stack/CodeEditor';
import type { Issue } from './stack/validate';
import { isValidRef } from './resources/imageRef';

type Source = 'editor' | 'upload' | 'git';

const SAMPLE = 'FROM busybox:latest\nWORKDIR /app\nRUN echo "built by Ervisio" > hello.txt\nCMD ["cat", "/app/hello.txt"]\n';

type Upload = { kind: 'archive'; file: File } | { kind: 'files'; picked: Picked[] };

const uploadSize = (u: Upload): number => (u.kind === 'archive' ? u.file.size : u.picked.reduce((n, p) => n + p.file.size, 0));

/** The line of the editor a failed step "Step 3/5 : RUN x" belongs to (first line that starts with the instruction). */
function lineOf(text: string, title: string): number {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const want = norm(title.split('\n')[0]);
  const i = text.split('\n').findIndex((l) => norm(l).startsWith(want));
  return i < 0 ? 0 : i + 1;
}

/** Build image: Dockerfile editor, uploaded context or Git URL, with live output. */
export function BuildPage() {
  const [source, setSource] = useState<Source>('editor');
  const [dockerfile, setDockerfile] = useState(SAMPLE);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [gitUrl, setGitUrl] = useState('');
  const [tags, setTags] = useState('');
  const [dfPath, setDfPath] = useState('');
  const [target, setTarget] = useState('');
  const [platform, setPlatform] = useState('');
  const [args, setArgs] = useState('');
  const [labels, setLabels] = useState('');
  const [noCache, setNoCache] = useState(false);
  const [pull, setPull] = useState(false);
  const [state, setState] = useState<BuildState | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const handle = useRef<{ close(): void } | null>(null);
  const edRef = useRef<HTMLDivElement>(null);
  const outRef = useRef<HTMLElement>(null);
  const archive = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement | null>(null);
  const running = !!state && !state.finished;

  useEffect(() => () => handle.current?.close(), []);

  const tagList = useMemo(() => tags.split(/[\s,]+/).filter(Boolean), [tags]);
  const badTag = tagList.find((x) => !isValidRef(x));
  const size = upload ? uploadSize(upload) : 0;

  const failedLine = useMemo(() => {
    const failed = state?.steps.find((s) => s.state === 'failed');
    return failed && source === 'editor' ? lineOf(dockerfile, failed.title) : 0;
    // Only when the state changes: editing afterwards must not move the marker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const issues: Issue[] = failedLine ? [{ line: failedLine, level: 'error', key: 'build.failedStep' }] : [];
  useEffect(() => {
    if (failedLine) jumpToLine(edRef.current, failedLine);
  }, [failedLine]);

  const start = async () => {
    setFormError('');
    if (badTag) return setFormError(t('build.badTag', { tag: badTag }));
    const a = parsePairs(args);
    if (a.bad) return setFormError(t('build.badPair', { field: t('build.args'), line: a.bad }));
    const l = parsePairs(labels);
    if (l.bad) return setFormError(t('build.badPair', { field: t('build.labels'), line: l.bad }));
    const opts: BuildOptions = {
      tags: tagList,
      dockerfile: source === 'upload' || source === 'git' ? dfPath.trim() || 'Dockerfile' : 'Dockerfile',
      buildArgs: a.pairs,
      target: target.trim(),
      noCache,
      pull,
      platform: platform.trim(),
      labels: l.pairs,
    };
    let src: BuildSource;
    setBusy(true);
    try {
      if (source === 'git') {
        if (!/^(https?:\/\/|git@|git:\/\/|github\.com\/)/.test(gitUrl.trim())) return setFormError(t('build.badUrl'));
        src = { kind: 'remote', url: gitUrl.trim() };
      } else if (source === 'upload') {
        if (!upload) return setFormError(t('build.noContext'));
        if (upload.kind === 'files' && !upload.picked.some((p) => p.path === opts.dockerfile)) return setFormError(t('build.noDockerfile', { path: opts.dockerfile }));
        if (upload.kind === 'files' && size > MAX_RAW_CONTEXT) return setFormError(t('build.tooBig', { size: formatBytes(size), max: formatBytes(MAX_CONTEXT) }));
        let tar = upload.kind === 'archive' ? new Uint8Array(await upload.file.arrayBuffer()) : await packPicked(upload.picked);
        // Plain tar contexts are compressed: source trees shrink a lot, and Docker detects gzip by itself.
        if (upload.kind === 'files' || (tar[0] !== 0x1f && tar.length > 4096)) tar = await gzip(tar);
        if (tar.length > MAX_CONTEXT) return setFormError(t('build.tooBig', { size: formatBytes(tar.length), max: formatBytes(MAX_CONTEXT) }));
        src = { kind: 'tar', tar };
      } else {
        if (!dockerfile.trim()) return setFormError(t('build.emptyDockerfile'));
        src = { kind: 'tar', tar: packTar([{ path: 'Dockerfile', data: new TextEncoder().encode(dockerfile) }]) };
      }
    } catch (e) {
      return setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
    setState({ pre: [], steps: [], activity: '', tagged: [], finished: false });
    requestAnimationFrame(() => outRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    handle.current = runBuild(src, opts, (s) => {
      setState(s);
      if (s.finished && !s.error && !s.cancelled) {
        void images.refresh();
        void diskUsage.refresh();
        toast.ok(t('build.done'));
      }
    });
  };

  const pick = (e: React.ChangeEvent<HTMLInputElement>, kind: 'archive' | 'files' | 'folder') => {
    const list = e.target.files;
    if (list && list.length) {
      if (kind === 'archive') setUpload({ kind: 'archive', file: list[0] });
      else setUpload({ kind: 'files', picked: pickedFrom(list, kind === 'folder') });
    }
    e.target.value = '';
  };

  const first = tagList[0];
  const ok = !!state && state.finished && !state.error && !state.cancelled;
  return (
    <>
      <PageHeader icon="image" hue="sw" title={t('build.title')} subtitle={t('build.sub')} back />
      <section className="dk-cr-card" aria-label={t('build.source')}>
        <div className="dk-bd-top">
          <h3>{t('build.source')}</h3>
          <Segmented
            aria-label={t('build.source')}
            value={source}
            onChange={(v) => setSource(v as Source)}
            options={[
              { value: 'editor', label: t('build.src.editor'), icon: 'code' },
              { value: 'upload', label: t('build.src.upload'), icon: 'upload' },
              { value: 'git', label: t('build.src.git'), icon: 'link' },
            ]}
          />
        </div>
        {source === 'editor' && (
          <>
            <div ref={edRef}>
              <CodeEditor value={dockerfile} onChange={setDockerfile} lang="dockerfile" issues={issues} label={t('build.dockerfile')} minLines={10} />
            </div>
            <p className="dk-note"><Icon name="info" />{t('build.editorNote')}</p>
          </>
        )}
        {source === 'upload' && (
          <>
            <div className="dk-bd-pick">
              <Button icon="archive" onClick={() => archive.current?.click()}>{t('build.pickArchive')}</Button>
              <Button icon="file" onClick={() => files.current?.click()}>{t('build.pickFiles')}</Button>
              <Button icon="folderplus" onClick={() => folder.current?.click()}>{t('build.pickFolder')}</Button>
              <input ref={archive} type="file" hidden accept=".tar,.tgz,.gz,.tar.gz,application/x-tar,application/gzip" onChange={(e) => pick(e, 'archive')} />
              <input ref={files} type="file" hidden multiple onChange={(e) => pick(e, 'files')} />
              <input ref={(el) => { folder.current = el; el?.setAttribute('webkitdirectory', ''); }} type="file" hidden multiple onChange={(e) => pick(e, 'folder')} />
            </div>
            {upload ? (
              <div className={`dk-bd-sel${size > (upload.kind === 'archive' ? MAX_CONTEXT : MAX_RAW_CONTEXT) ? ' dk-bd-sel--bad' : ''}`}>
                <Icon name={upload.kind === 'archive' ? 'archive' : 'file'} />
                <span className="dk-bd-selname">
                  {upload.kind === 'archive' ? upload.file.name : tn('build.filesCount', { n: upload.picked.length })}
                </span>
                <span className="dk-muted">{formatBytes(size)}</span>
                <Button size="sm" variant="ghost" icon="close" onClick={() => setUpload(null)}>{t('build.clear')}</Button>
              </div>
            ) : (
              <p className="dk-muted">{t('build.noContext')}</p>
            )}
            {upload?.kind === 'files' && (
              <ul className="dk-bd-files" aria-label={t('build.pickFiles')}>
                {upload.picked.slice(0, 40).map((p) => <li key={p.path}><code>{p.path}</code><small className="dk-muted">{formatBytes(p.file.size)}</small></li>)}
                {upload.picked.length > 40 && <li className="dk-muted">{t('build.more', { n: upload.picked.length - 40 })}</li>}
              </ul>
            )}
            <p className="dk-note"><Icon name="info" />{t('build.limitNote', { max: formatBytes(MAX_CONTEXT) })}</p>
          </>
        )}
        {source === 'git' && (
          <Input
            mono
            label={t('build.gitUrl')}
            placeholder="https://github.com/owner/repo.git#main:subfolder"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            hint={t('build.gitHint')}
          />
        )}
      </section>

      <section className="dk-cr-card" aria-label={t('build.options')}>
        <h3>{t('build.options')}</h3>
        <Input
          mono
          label={t('build.tags')}
          placeholder="myapp:1.0 myapp:latest"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          error={badTag ? t('build.badTag', { tag: badTag }) : undefined}
          hint={t('build.tagsHint')}
        />
        <div className="dk-cr-g2">
          {source !== 'editor' && <Input mono label={t('build.dockerfilePath')} placeholder="Dockerfile" value={dfPath} onChange={(e) => setDfPath(e.target.value)} hint={t('build.dockerfilePathHint')} />}
          <Input mono label={t('build.target')} placeholder="runtime" value={target} onChange={(e) => setTarget(e.target.value)} hint={t('build.targetHint')} />
          <Input mono label={t('build.platform')} placeholder="linux/amd64" value={platform} onChange={(e) => setPlatform(e.target.value)} hint={t('build.platformHint')} />
        </div>
        <div className="dk-cr-g2">
          <Textarea mono rows={3} label={t('build.args')} placeholder={'VERSION=1.2\nPROXY=http://proxy:3128'} value={args} onChange={(e) => setArgs(e.target.value)} hint={t('build.pairsHint')} />
          <Textarea mono rows={3} label={t('build.labels')} placeholder={'org.opencontainers.image.source=https://…'} value={labels} onChange={(e) => setLabels(e.target.value)} hint={t('build.pairsHint')} />
        </div>
        <div className="dk-bd-sw">
          <Checkbox checked={noCache} onChange={setNoCache} label={t('build.noCache')} />
          <Checkbox checked={pull} onChange={setPull} label={t('build.pull')} />
        </div>
        <p className="dk-note"><Icon name="key" />{t('build.authNote')}</p>
      </section>

      <div className="dk-bd-go">
        {running ? (
          <Button variant="danger" icon="stop" onClick={() => handle.current?.close()}>{t('build.cancel')}</Button>
        ) : (
          <Button variant="primary" icon="play" loading={busy} onClick={() => void start()}>{t('build.go')}</Button>
        )}
        {formError && <p className="dk-fail" role="alert"><Icon name="alert" />{formError}</p>}
      </div>

      {state && (
        <section ref={outRef} className="dk-cr-card" aria-label={t('build.output')}>
          <div className="dk-bd-top">
            <h3>{t('build.output')}</h3>
            {running && <small className="dk-muted">{t('build.running')}</small>}
            {state.cancelled && <small className="dk-muted">{t('build.cancelled')}</small>}
          </div>
          <BuildOutput state={state} />
          {ok && (
            <div className="dk-bd-ok">
              <p className="dk-okmsg"><Icon name="check" />{t('build.success', { id: state.imageId ?? '' })}</p>
              {state.tagged.length > 0 && <p className="dk-muted">{t('build.tagged', { tags: state.tagged.join(', ') })}</p>}
              <div className="dk-bd-pick">
                <Button variant="primary" icon="play" onClick={() => navigate({ view: 'create', image: first ?? state.imageId })}>{t('build.run')}</Button>
                <Button icon="image" onClick={() => navigate({ view: 'images' })}>{t('build.toImages')}</Button>
              </div>
            </div>
          )}
        </section>
      )}
    </>
  );
}
