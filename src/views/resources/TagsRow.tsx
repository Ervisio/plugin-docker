import { useState } from 'react';
import { docker, errorText } from '../../api/engine';
import { images } from '../../api/resources';
import { t } from '../../i18n';
import { Button, Icon, IconButton, Input, toast } from '../../kit';
import { isValidRef, refPath, splitRef } from './imageRef';
import { forget } from './updates';

/** Tags of one image: add a name, or remove one without deleting the image (only while another tag keeps it). */
export function TagsRow({ id, tags }: { id: string; tags: string[] }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const clean = text.trim();
  const bad = clean !== '' && !isValidRef(clean);
  const dup = clean !== '' && tags.some((x) => x === clean || (!clean.includes(':') && x === `${clean}:latest`));

  const add = async () => {
    const { name, tag } = splitRef(clean);
    setBusy(true);
    try {
      await docker.post(`/images/${refPath(id)}/tag`, { repo: name, tag });
      toast.ok(t('tags.added', { ref: `${name}:${tag}` }));
      setText('');
      await images.refresh();
    } catch (e) {
      toast.err(t('tags.addFail'), errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (ref: string) => {
    try {
      await docker.delete(`/images/${refPath(ref)}`, { force: '0' });
      forget(ref);
      toast.ok(t('tags.removed', { ref }));
      await images.refresh();
    } catch (e) {
      toast.err(t('tags.removeFail', { ref }), errorText(e));
    }
  };

  return (
    <div className="dk-tags-box">
      <b>{t('tags.title')}</b>
      <div className="dk-tags">
        {tags.length === 0 && <span className="dk-muted">{t('tags.none')}</span>}
        {tags.map((ref) => (
          <span key={ref} className="dk-tagchip">
            {ref}
            <IconButton
              icon="close"
              size="sm"
              variant="ghost"
              label={tags.length > 1 ? t('tags.remove', { ref }) : t('tags.lastHint')}
              disabled={tags.length < 2}
              onClick={() => void remove(ref)}
            />
          </span>
        ))}
      </div>
      <form
        className="dk-tagadd"
        onSubmit={(e) => {
          e.preventDefault();
          if (clean && !bad && !dup && !busy) void add();
        }}
      >
        <Input
          fieldClassName="dk-grow"
          mono
          placeholder="myapp:1.0"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={t('tags.add')}
          error={bad ? t('tags.bad') : dup ? t('tags.dup') : undefined}
        />
        <Button type="submit" icon="tag" disabled={!clean || bad || dup} loading={busy}>{t('tags.add')}</Button>
      </form>
      {tags.length === 1 && <p className="dk-note"><Icon name="info" />{t('tags.lastHint')}</p>}
    </div>
  );
}
