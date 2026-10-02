import type { MovePlan } from '../../api/compose';
import { t } from '../../i18n';

/** The body of the "Move to /opt/stacks" dialog for a project whose files live in another container. */
export function MovePreview({ plan, dir, fromPortainer }: { plan: MovePlan; dir: string; fromPortainer: boolean }) {
  return (
    <div className="dk-sk-mv">
      <p>{t('stacks.move.files', { dir })}</p>
      <ul>{plan.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
      {plan.changes.length > 0 ? (
        <>
          <p>{t('stacks.move.binds')}</p>
          <ul>
            {plan.changes.map((c, i) => (
              <li key={i}><code>{c.service}</code> <code>{c.from}</code> → <code>{c.to}</code></li>
            ))}
          </ul>
        </>
      ) : (
        <p className="dk-muted">{t('stacks.move.noBinds')}</p>
      )}
      {plan.warnings.length > 0 && (
        <>
          <p>{t('stacks.move.warnings')}</p>
          <ul>{plan.warnings.map((w, i) => <li key={i}>{t(`stacks.move.warn.${w.kind}`, { service: w.service ?? '', value: w.value })}</li>)}</ul>
        </>
      )}
      <p>{t('stacks.move.recreate')}</p>
      <p>{fromPortainer ? t('stacks.move.afterPortainer') : t('stacks.move.afterOther')}</p>
    </div>
  );
}
