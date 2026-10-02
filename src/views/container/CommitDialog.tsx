import { useEffect, useState } from 'react';
import { checkRef, commitContainer, parseChanges } from '../../api/commit';
import { errorText } from '../../api/engine';
import { images } from '../../api/resources';
import { shortId } from '../../api/format';
import { t } from '../../i18n';
import { Button, Checkbox, Dialog, Icon, Input, Textarea, toast } from '../../kit';
import { navigate, setSearch } from '../../router';

/** "Save as image": docker commit. The image is made from the container's file system and, optionally, new defaults. */
export function CommitDialog({ open, onClose, id, name, image, running }: { open: boolean; onClose(): void; id: string; name: string; image: string; running: boolean }) {
  const [repo, setRepo] = useState('');
  const [tag, setTag] = useState('latest');
  const [comment, setComment] = useState('');
  const [author, setAuthor] = useState('');
  const [changes, setChanges] = useState('');
  const [pause, setPause] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ ref: string; id: string } | undefined>();

  useEffect(() => {
    if (open) {
      setRepo(name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, ''));
      setTag('latest');
      setComment('');
      setAuthor('');
      setChanges('');
      setPause(true);
      setBusy(false);
      setErr('');
      setDone(undefined);
    }
  }, [open, name]);

  const refErr = repo.trim() || tag !== 'latest' ? checkRef(repo, tag) : '';
  const parsed = parseChanges(changes);
  const changesErr = parsed.badLine ? t('commit.err.changes', { n: parsed.badLine }) : '';
  const ready = !checkRef(repo, tag) && !parsed.badLine;

  const run = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr('');
    try {
      const newId = await commitContainer(id, { repo, tag, comment, author, pause: pause && running, changes: parsed.lines });
      const ref = `${repo.trim()}:${tag.trim() || 'latest'}`;
      setDone({ ref, id: newId });
      toast.ok(t('commit.done', { ref }));
      void images.refresh();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const showImage = () => {
    if (!done) return;
    setSearch(done.ref);
    onClose();
    navigate({ view: 'images' });
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={t('commit.title')}
      description={done ? undefined : t('commit.desc', { name })}
      icon="archive"
      size="lg"
      footer={
        done ? (
          <>
            <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
            <Button variant="primary" icon="image" onClick={showImage}>{t('commit.show')}</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" icon="archive" loading={busy} disabled={!ready} onClick={() => void run()}>{t('commit.button')}</Button>
          </>
        )
      }
    >
      {done ? (
        <div className="dk-c-commit-done" role="status">
          <Icon name="check" size={18} />
          <div>
            <b>{t('commit.done', { ref: done.ref })}</b>
            <p className="dk-muted dk-c-p">{t('commit.doneText', { id: shortId(done.id) })}</p>
          </div>
        </div>
      ) : (
        <div className="dk-c-commit" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') void run(); }}>
          <div className="dk-c-commit-ref">
            <Input label={t('commit.repo')} mono autoFocus value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="myapp" error={refErr && refErr !== 'commit.err.tag' ? t(refErr) : undefined} hint={t('commit.repo.hint')} spellCheck={false} autoCapitalize="off" />
            <Input label={t('commit.tag')} mono value={tag} onChange={(e) => setTag(e.target.value)} placeholder="latest" error={refErr === 'commit.err.tag' ? t(refErr) : undefined} spellCheck={false} autoCapitalize="off" />
          </div>
          <div className="dk-c-commit-ref">
            <Input label={t('commit.comment')} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('commit.comment.ph')} />
            <Input label={t('commit.author')} value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Jane Doe <jane@example.com>" />
          </div>
          <Textarea label={t('commit.changes')} mono rows={4} value={changes} onChange={(e) => setChanges(e.target.value)} placeholder={'CMD ["nginx", "-g", "daemon off;"]\nENV MODE=production\nEXPOSE 8080'} hint={t('commit.changes.hint')} error={changesErr || undefined} spellCheck={false} />
          <Checkbox checked={pause && running} onChange={setPause} disabled={!running} label={running ? t('commit.pause') : t('commit.pause.stopped')} />
          {running && pause && <p className="dk-muted dk-c-p">{t('commit.pause.note')}</p>}
          <p className="dk-muted dk-c-p">{t('commit.note', { image })}</p>
          {err && <p className="dk-c-err" role="alert">{err}</p>}
        </div>
      )}
    </Dialog>
  );
}
