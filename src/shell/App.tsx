import { useEffect, useState } from 'react';
import { useAlertEngine } from '../api/alerts';
import { envList } from '../api/envList';
import { KIND_HUE, KIND_ICON } from '../api/envHealth';
import { useEnv } from '../api/useEnv';
import { containers, images, info, networks, volumes } from '../api/resources';
import { resetEngine } from '../api/engine';
import { groupByStack } from '../api/model';
import { t } from '../i18n';
import { Icon, IconButton, Input, Skeleton } from '../kit';
import { navigate, sectionOf, setSearch, useRoute, useSearch, type NavId } from '../router';
import { openCoreSettings } from '../views/EnvironmentsPage';
import { ErrorState } from '../ui/ErrorState';
import { NAV_ICONS } from '../ui/icons';
import { ViewHost } from '../views/registry';

const GROUPS: { label: string; items: NavId[] }[] = [
  { label: 'nav.workloads', items: ['containers', 'stacks', 'templates'] },
  { label: 'nav.resources', items: ['images', 'volumes', 'networks', 'registries'] },
  { label: 'nav.tools', items: ['cleanup', 'autoupdate', 'alerts', 'portainer', 'activity', 'settings'] },
];

/** Views that list things the search box can filter. */
const SEARCHABLE: NavId[] = ['containers', 'stacks', 'images'];
/** Views that work without a running engine. */
const OFFLINE_OK: NavId[] = ['registries', 'settings', 'environments', 'activity'];
/** Views that are about every host, not the open one. */
const GLOBAL_VIEWS: NavId[] = ['environments', 'activity'];

/** The page: inner sidebar, search box, and the view for the current route. */
export function App() {
  useAlertEngine();
  const route = useRoute();
  const { data: envs, error: envError } = envList.use();
  const { env, info: envInfo, multi } = useEnv();
  const section = sectionOf(route);
  const q = useSearch();
  const cs = containers.use();
  const imgs = images.use();
  const vols = volumes.use();
  const nets = networks.use();
  const eng = info.use();

  const counts: Partial<Record<NavId, number>> = {};
  if (cs.data) {
    counts.containers = cs.data.length;
    counts.stacks = groupByStack(cs.data).filter((g) => g.name).length;
  }
  if (imgs.data) counts.images = imgs.data.length;
  if (vols.data) counts.volumes = vols.data.length;
  if (nets.data) counts.networks = nets.data.length;

  const onSearch = (v: string) => {
    setSearch(v);
    if (v && !SEARCHABLE.includes(section)) navigate({ view: 'containers' }, { root: true });
  };

  const blocked = !cs.data && cs.error && !OFFLINE_OK.includes(section);

  // With more than this server, the plugin starts on the Environments page. Decided once, when the list first arrives.
  const [decided, setDecided] = useState(false);
  const ready = envs !== undefined || !!envError;
  useEffect(() => {
    if (!ready || decided) return;
    if (envs && envs.length > 0 && route.view === 'containers' && !env) navigate({ view: 'environments' }, { root: true });
    setDecided(true);
  }, [ready, decided, envs, route.view, env]);
  if (!ready || !decided) {
    return <div className="dk-root hue-file"><div className="dk-shell"><Skeleton height={220} style={{ borderRadius: 18, width: 220 }} /><div className="dk-main"><Skeleton height={60} style={{ borderRadius: 18 }} /><Skeleton height={260} style={{ borderRadius: 18 }} /></div></div></div>;
  }
  const home = route.view === 'environments';
  const here = env ? { name: envInfo?.name ?? env, kind: envInfo?.kind ?? 'ssh' } : { name: t('envs.local'), kind: 'local' as const };
  const hereSub = env ? [t(`envs.kind.${here.kind}`), eng.data?.info.Name].filter(Boolean).join(', ') : [t('envs.kind.local'), eng.data?.info.Name].filter(Boolean).join(', ');

  return (
    <div className="dk-root hue-file">
      <div className="dk-shell">
        {!home && <nav className="dk-nav" aria-label={t('nav.aria')}>
          {multi && (
            <div className="dk-nav-env">
              <button type="button" className="dk-nav-back" onClick={() => navigate({ view: 'environments' }, { root: true })}>
                <Icon name="chevronleft" />{t('envs.back')}
              </button>
              {!GLOBAL_VIEWS.includes(section) && (
                <div className={`dk-nav-cur hue-${KIND_HUE[here.kind]}`} title={`${here.name}, ${hereSub}`}>
                  <span className="dk-ev-ic"><Icon name={KIND_ICON[here.kind]} /></span>
                  <div className="dk-nav-cur-t"><b>{here.name}</b><span>{hereSub}</span></div>
                </div>
              )}
            </div>
          )}
          {GROUPS.map((g) => (
            <div key={g.label} style={{ display: 'contents' }}>
              <div className="dk-nav-gl">{t(g.label)}</div>
              {g.items.map((id) => (
                <button key={id} type="button" className="dk-nav-it" aria-current={section === id ? 'page' : undefined} onClick={() => navigate({ view: id } as never, { root: true })}>
                  <Icon name={NAV_ICONS[id]} />
                  {t(`nav.${id}`)}
                  {counts[id] !== undefined && <b>{counts[id]}</b>}
                </button>
              ))}
            </div>
          ))}
          {eng.data && <div className="dk-nav-ft"><span className="dk-dot dk-dot--ok" />{t('shell.engine', { version: eng.data.version.Version })}</div>}
          {!multi && <button type="button" className="dk-nav-back dk-nav-env-add" onClick={openCoreSettings} title={t('envs.addCard.where')}><Icon name="plus" />{t('envs.addCard.title')}</button>}
        </nav>}
        <div className="dk-main">
          {!home && <div className="dk-top">
            <Input
              fieldClassName="dk-search"
              icon="search"
              value={q}
              placeholder={t('shell.search')}
              aria-label={t('shell.search')}
              onChange={(e) => onSearch(e.target.value)}
              end={q ? <IconButton icon="close" label={t('common.close')} size="sm" onClick={() => setSearch('')} /> : undefined}
            />
          </div>}
          <div className="dk-view">
            {blocked ? <ErrorState error={cs.error!} onRetry={() => { resetEngine(); void containers.refresh(); }} /> : <ViewHost key={`${env ?? ''}|${JSON.stringify(route)}`} route={route} />}
          </div>
        </div>
      </div>
    </div>
  );
}
