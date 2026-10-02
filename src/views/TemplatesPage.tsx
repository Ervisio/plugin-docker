import { useMemo, useState } from 'react';
import { containers } from '../api/resources';
import { BUILTIN_ID, CUSTOM_ID, useTemplates, type Template } from '../api/templates';
import { TEMPLATES_DIR } from '../api/customTemplates';
import { t } from '../i18n';
import { Badge, Button, Chip, EmptyState, Icon, Input, Select, Skeleton } from '../kit';
import { navigate } from '../router';
import { PageHeader } from '../ui/PageHeader';
import { CustomMenu, ImportTemplatesDialog } from './templates/CustomActions';
import { SourcesPanel } from './templates/SourcesPanel';
import { isInstalled, Tile } from './templates/shared';

const norm = (s: string) => s.toLowerCase();

/** Templates store (design 030 b): search, categories, featured row, source filter, grid of apps. */
export function TemplatesPage() {
  const cat = useTemplates();
  const { data: list } = containers.use();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [source, setSource] = useState('');
  const [showSources, setShowSources] = useState(false);
  const [allCats, setAllCats] = useState(false);
  const [importing, setImporting] = useState(false);

  const categories = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of cat.templates) m.set(x.category, (m.get(x.category) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [cat.templates]);
  const visibleCats = allCats ? categories : categories.filter(([c], i) => i < 10 || c === category);

  const shown = useMemo(() => {
    const n = norm(q.trim());
    return cat.templates
      .filter((x) => (!category || x.category === category) && (!source || x.source === source))
      .filter((x) => !n || norm(x.name).includes(n) || norm(x.description).includes(n) || norm(x.category).includes(n))
      .sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === BUILTIN_ID ? -1 : b.source === BUILTIN_ID ? 1 : 0));
  }, [cat.templates, q, category, source]);

  const unfiltered = !q.trim() && !category && !source;
  const customCount = cat.templates.filter((x) => x.source === CUSTOM_ID).length;
  // With no filter the custom templates get their own section above the catalog.
  const yours = unfiltered ? shown.filter((x) => x.source === CUSTOM_ID) : [];
  const grid = unfiltered ? shown.filter((x) => x.source !== CUSTOM_ID) : shown;
  const featured = unfiltered ? cat.templates.filter((x) => x.featured).slice(0, 4) : [];
  const failed = cat.sources.filter((s) => s.error);
  const open = (x: Template) => navigate({ view: 'template', id: x.id });
  const installed = (x: Template) => isInstalled(x, list);

  const card = (x: Template) => (
    <div key={x.id} className={`dk-tp-card hue-${x.hue}${x.source === CUSTOM_ID ? ' dk-tp-card--custom' : ''}`} role="button" tabIndex={0} onClick={() => open(x)} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(x); } }}>
      <div className="dk-tp-ct">
        <Tile name={x.name} hue={x.hue} />
        <div className="dk-tp-ctx">
          <b>{x.name}</b>
          <span className="dk-tp-src">{x.category}, {x.sourceName}</span>
        </div>
        {x.source === CUSTOM_ID && <span className="dk-tp-cardmenu"><CustomMenu tpl={x} stop /></span>}
      </div>
      <p>{x.description || ' '}</p>
      <div className="dk-tp-cf">
        <span className="dk-muted">{x.type === 'stack' ? t('templates.type.stack') : t('templates.type.container')}</span>
        {installed(x) ? <Badge tone="ok" dot>{t('templates.installed')}</Badge> : <Button size="sm" variant="primary" onClick={(e) => { e.stopPropagation(); open(x); }}>{t('templates.install')}</Button>}
      </div>
    </div>
  );

  return (
    <>
      <PageHeader
        icon="store"
        title={t('nav.templates')}
        subtitle={t('templates.sub', { apps: cat.templates.length, sources: cat.sources.length })}
        actions={
          <>
            <Button icon="link" onClick={() => setShowSources((v) => !v)}>{t('templates.sources')}</Button>
            <Button icon="upload" onClick={() => setImporting(true)}>{t('templates.custom.import')}</Button>
            <Button variant="primary" icon="plus" onClick={() => navigate({ view: 'template-edit' })}>{t('templates.custom.new')}</Button>
          </>
        }
      />
      <div className="dk-tp">
        {showSources && <SourcesPanel status={cat.sources} onReload={cat.reload} />}
        {failed.map((s) => (
          <div className="dk-tp-warn" key={s.id} role="alert">
            <Icon name="alert" size={16} />
            <span><b>{s.name}</b>: {s.error}</span>
            <Button size="sm" onClick={cat.reload}>{t('common.retry')}</Button>
          </div>
        ))}

        <div className="dk-tp-bar">
          <Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('templates.search', { n: cat.templates.length })} aria-label={t('common.search')} fieldClassName="dk-tp-q" />
          {cat.sources.length > 1 && (
            <Select compact value={source} onChange={setSource} aria-label={t('templates.source')} options={[{ value: '', label: t('templates.allSources') }, ...cat.sources.filter((s) => s.count > 0).map((s) => ({ value: s.id, label: s.name }))]} />
          )}
        </div>
        <div className="dk-tp-cats" role="group" aria-label={t('templates.categories')}>
          <Chip pressed={!category && source !== CUSTOM_ID} onClick={() => { setCategory(''); setSource(''); }}>{t('common.all')}</Chip>
          <Chip pressed={source === CUSTOM_ID} icon="user" count={customCount} onClick={() => { setSource(source === CUSTOM_ID ? '' : CUSTOM_ID); setCategory(''); }}>{t('templates.custom.filter')}</Chip>
          {visibleCats.map(([c, n]) => <Chip key={c} pressed={category === c} count={n} onClick={() => setCategory(category === c ? '' : c)}>{c}</Chip>)}
          {categories.length > 10 && <Chip onClick={() => setAllCats((v) => !v)}>{allCats ? t('templates.fewer') : t('templates.more', { n: categories.length - 10 })}</Chip>}
        </div>

        {featured.length > 0 && (
          <div className="dk-tp-feat" aria-label={t('templates.featured')}>
            {featured.map((x) => (
              <button type="button" key={x.id} className={`dk-tp-fc hue-${x.hue}`} onClick={() => open(x)}>
                <Tile name={x.name} hue={x.hue} size="lg" />
                <div>
                  <small>{t('templates.featured')}</small>
                  <b>{x.name}</b>
                  <span>{x.description}</span>
                </div>
              </button>
            ))}
          </div>
        )}

        {yours.length > 0 && (
          <section className="dk-tp-yours" aria-label={t('templates.custom.section')}>
            <h3>{t('templates.custom.section')}</h3>
            <p className="dk-muted">{t('templates.custom.where', { dir: TEMPLATES_DIR })}</p>
            <div className="dk-tp-grid">{yours.map(card)}</div>
          </section>
        )}
        {cat.loading && cat.templates.length === 0 ? (
          <div className="dk-tp-grid">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} height={150} style={{ borderRadius: 18 }} />)}</div>
        ) : source === CUSTOM_ID && grid.length === 0 && !q.trim() ? (
          <EmptyState
            icon="store"
            title={t('templates.custom.empty.title')}
            text={t('templates.custom.empty.text', { dir: TEMPLATES_DIR })}
            action={<div className="dk-cr-row"><Button variant="primary" icon="plus" onClick={() => navigate({ view: 'template-edit' })}>{t('templates.custom.new')}</Button><Button icon="upload" onClick={() => setImporting(true)}>{t('templates.custom.import')}</Button></div>}
          />
        ) : grid.length === 0 && yours.length === 0 ? (
          <EmptyState icon="search" title={t('templates.none.title')} text={t('templates.none.text')} />
        ) : grid.length > 0 ? (
          <div className="dk-tp-grid">{grid.map(card)}</div>
        ) : null}
        {cat.loading && cat.templates.length > 0 && <p className="dk-muted">{t('templates.loadingMore')}</p>}
      </div>
      <ImportTemplatesDialog open={importing} onClose={() => setImporting(false)} />
    </>
  );
}
