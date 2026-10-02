import { shortId } from '../../api/format';
import { t } from '../../i18n';
import type { PullLayer } from './pull';

/** One progress bar per layer, as shown for pulls and pushes. */
export function LayerList({ layers }: { layers: PullLayer[] }) {
  const done = layers.filter((l) => l.done).length;
  return (
    <>
      {layers.length > 0 && <small className="dk-muted">{t('res.pull.layers', { done, total: layers.length })}</small>}
      {layers.map((l) => (
        <div key={l.id} className={`dk-layer${l.done ? ' dk-layer--done' : ''}`}>
          <code>{shortId(l.id)}</code>
          <span className="dk-bar" role="progressbar" aria-valuenow={Math.round(l.pct * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.round(l.pct * 100)}%` }} /></span>
          <small>{l.status}</small>
        </div>
      ))}
    </>
  );
}
