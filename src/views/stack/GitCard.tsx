import { useCallback, useEffect, useState } from 'react';
import { checkForUpdate, commitOf, localEdits, type CommitInfo, type GitMeta } from '../../api/git';
import { repoLabel } from '../../api/gitMeta';
import { t } from '../../i18n';
import { Badge, Button, Card, Icon, toast } from '../../kit';
import { CopyButton } from '../resources/bits';

/** Where a Git stack comes from, the commit it is at, and what updating does. */
export function GitCard({ name, meta, tick, busy, onPull, onDetach, onEdits }: {
  name: string;
  meta: GitMeta;
  /** Changes when something ran that may have moved the repository. */
  tick: number;
  busy: boolean;
  onPull(): void;
  onDetach(): void;
  /** Reports the tracked files that differ from the repository. */
  onEdits?(files: string[]): void;
}) {
  const [commit, setCommit] = useState<CommitInfo | null>(null);
  const [edits, setEdits] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<{ behind: boolean; remote: string } | null>(null);

  const load = useCallback(async () => {
    const [c, e] = await Promise.all([commitOf(name), localEdits(name)]);
    setCommit(c);
    setEdits(e);
    onEdits?.(e);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setFound(null); void load(); }, [load, tick]);

  const check = async () => {
    setChecking(true);
    try {
      const r = await checkForUpdate(name, meta);
      setFound({ behind: r.behind, remote: r.remote });
    } catch (e) {
      toast.err(t('git.checkFail'), (e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const date = commit?.date ? new Date(commit.date).toLocaleString() : '';
  return (
    <Card title={t('git.title')} icon="git" action={<Badge tone="neutral">{meta.ref}</Badge>}>
      <dl className="dk-jb-facts">
        <div><dt>{t('git.repo')}</dt><dd><span className="dk-jb-mono" title={meta.url}>{repoLabel(meta.url)}</span><CopyButton text={meta.url} /></dd></div>
        <div><dt>{t('git.file')}</dt><dd><span className="dk-jb-mono">{meta.compose}</span></dd></div>
        <div><dt>{t('git.login')}</dt><dd>{t(`git.login.${meta.auth}`)}{meta.by && meta.auth !== 'none' ? ` (${meta.by})` : ''}</dd></div>
        <div><dt>{t('git.commit')}</dt><dd>{commit ? <><span className="dk-jb-mono">{commit.hash.slice(0, 8)}</span> <span title={commit.subject} className="dk-jb-subj">{commit.subject}</span></> : '–'}</dd></div>
        {commit && <div><dt>{t('git.by')}</dt><dd>{commit.author}{date ? `, ${date}` : ''}</dd></div>}
      </dl>
      {edits.length > 0 && (
        <div className="dk-jb-warn" role="status">
          <Icon name="alert" />
          <div>
            <b>{t('git.edits.title')}</b>
            <p>{t('git.edits.text', { files: edits.join(', ') })}</p>
            <Button size="sm" variant="ghost" onClick={onDetach}>{t('git.detach')}</Button>
          </div>
        </div>
      )}
      {found && (
        <p className={found.behind ? 'dk-jb-new' : 'dk-muted'} role="status">{found.behind ? t('git.newer', { commit: found.remote.slice(0, 8) }) : t('git.upToDate')}</p>
      )}
      <div className="dk-jb-btns">
        <Button size="sm" icon="refresh" loading={checking} disabled={busy} onClick={() => void check()}>{t('git.check')}</Button>
        <Button size="sm" variant="primary" icon="download" disabled={busy} onClick={onPull}>{t('git.pull')}</Button>
        <Button size="sm" variant="ghost" onClick={onDetach}>{t('git.detach')}</Button>
      </div>
      <p className="dk-muted">{t('git.note')}</p>
    </Card>
  );
}
