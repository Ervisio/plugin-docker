import { useEffect, useMemo, useRef, useState } from 'react';
import { docker, errorText } from '../../api/engine';
import { ANONYMOUS_AUTH, authHeader, DOCKER_HUB, normalizeServer, registryHost, type Registry } from '../../api/registries';
import { useFile } from '../../settings';
import { t } from '../../i18n';
import { Button, Icon, Input, Select } from '../../kit';
import { isValidRef, refPath, splitRef } from './imageRef';
import { LayerList } from './LayerList';
import type { PullState } from './pull';
import { pushImage } from './push';

const OTHER = '__other';

/**
 * Inline "Push" form: pick a stored registry (or type another host), choose the repository and tag, then watch the
 * upload layer by layer. When the image does not have that name yet it is tagged first.
 */
export function PushPanel({ image, onClose, onDone }: {
  image: { id: string; tags: string[] };
  onClose(): void;
  onDone?(): void;
}) {
  const [file, , loaded] = useFile('registries');
  const saved = (file.registries ?? []).filter((r) => r.username);
  const first = image.tags[0] ?? '';
  const { name: firstName, tag: firstTag } = first ? splitRef(first) : { name: '', tag: 'latest' };
  const firstHost = first ? registryHost(first) : '';
  const [reg, setReg] = useState('');
  const [host, setHost] = useState('');
  const [repo, setRepo] = useState('');
  const [tag, setTag] = useState(firstTag || 'latest');
  const [touched, setTouched] = useState(false);
  const [state, setState] = useState<(PullState & { digest?: string }) | null>(null);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const handle = useRef<{ close(): void } | null>(null);
  const picked = useRef(false);

  // Start on the registry the image already points to, else the first stored one.
  useEffect(() => {
    if (picked.current || !loaded) return;
    picked.current = true;
    const m = saved.find((r) => normalizeServer(r.server) === firstHost);
    setReg(m ? m.id : saved[0] ? saved[0].id : OTHER);
    if (!m && !saved[0]) setHost(first && firstHost !== DOCKER_HUB ? firstHost : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const chosen: Registry | undefined = saved.find((r) => r.id === reg);
  const server = reg === OTHER ? normalizeServer(host) : chosen ? normalizeServer(chosen.server) : '';
  const hub = server === DOCKER_HUB;

  // Suggest a repository for the chosen registry until the user types one.
  const suggested = useMemo(() => {
    if (!server) return '';
    // Keep the image's own path (ervti/app), without the registry it came from.
    const own = (firstHost !== DOCKER_HUB && firstName.startsWith(`${firstName.split('/')[0]}/`) ? firstName.split('/').slice(1).join('/') : firstName.replace(/^docker\.io\//, '')) || 'image';
    return hub && !own.includes('/') && chosen?.username ? `${chosen.username}/${own}` : own;
  }, [server, hub, firstName, firstHost, chosen]);
  useEffect(() => {
    if (!touched) setRepo(suggested);
  }, [suggested, touched]);

  const full = server && repo.trim() ? `${hub ? '' : `${server}/`}${repo.trim()}` : '';
  const ref = full ? `${full}:${tag.trim() || 'latest'}` : '';
  const problem = !server ? 'host' : !repo.trim() || !isValidRef(ref) ? 'ref' : hub && !repo.includes('/') ? 'hub' : '';
  const running = busy || (!!state && !state.finished && !state.error);
  const authHint = chosen ? t('push.withLogin', { user: chosen.username, server: chosen.server }) : t('push.noLogin');

  useEffect(() => () => handle.current?.close(), []);

  const go = async () => {
    setBusy(true);
    setState({ layers: [], message: '', finished: false });
    setTarget(ref);
    try {
      if (!image.tags.includes(ref) && !(ref.endsWith(':latest') && image.tags.includes(ref.replace(/:latest$/, '')))) {
        const { name, tag: tg } = splitRef(ref);
        await docker.post(`/images/${refPath(image.id)}/tag`, { repo: name, tag: tg });
      }
    } catch (e) {
      setState({ layers: [], message: '', finished: true, error: t('push.tagFail', { error: errorText(e) }) });
      setBusy(false);
      return;
    }
    setBusy(false);
    const { name, tag: tg } = splitRef(ref);
    handle.current = pushImage(name, tg, chosen ? authHeader(chosen) : ANONYMOUS_AUTH, (s) => {
      setState(s);
      if (s.finished) onDone?.();
    });
  };

  const options = [
    ...saved.map((r) => ({ value: r.id, label: `${r.server} (${r.username})` })),
    { value: OTHER, label: t('push.other') },
  ];
  return (
    <section className="dk-card dk-pull" aria-label={t('push.title')}>
      <div className="dk-card-h">
        <h3>{t('push.title')}</h3>
        <Button size="sm" variant="ghost" icon="close" onClick={() => { handle.current?.close(); onClose(); }}>{running ? t('push.cancel') : t('common.close')}</Button>
      </div>
      <div className="dk-push-f">
        <Select label={t('push.registry')} options={options} value={reg} onChange={(v) => { setReg(v); setTouched(false); }} disabled={running} />
        {reg === OTHER && (
          <Input mono label={t('push.host')} placeholder="localhost:5000" value={host} onChange={(e) => { setHost(e.target.value); setTouched(false); }} disabled={running} hint={t('push.hostHint')} />
        )}
        <Input mono label={t('push.repo')} placeholder={hub ? 'owner/app' : 'team/app'} value={repo} onChange={(e) => { setRepo(e.target.value); setTouched(true); }} disabled={running} />
        <Input mono label={t('push.tag')} placeholder="latest" value={tag} onChange={(e) => setTag(e.target.value)} disabled={running} />
      </div>
      <small className="dk-muted">
        {ref ? t('push.target', { ref }) : t('push.pick')} {authHint}
      </small>
      {problem === 'hub' && <p className="dk-fail"><Icon name="alert" />{t('push.hubNeedsOwner')}</p>}
      <div>
        <Button variant="primary" icon="upload" disabled={!!problem || running} loading={running} onClick={() => void go()}>{t('push.go')}</Button>
      </div>
      {state && (
        <div className="dk-layers" aria-live="polite">
          <LayerList layers={state.layers} />
          {state.error && <p className="dk-fail"><Icon name="alert" />{state.error}</p>}
          {!state.error && state.finished && <p className="dk-okmsg"><Icon name="check" />{t('push.done', { ref: target })}</p>}
          {!state.error && state.finished && state.digest && <small className="dk-muted"><code>{state.digest}</code></small>}
          {!state.error && !state.finished && state.message && <small className="dk-muted">{state.message}</small>}
        </div>
      )}
    </section>
  );
}
