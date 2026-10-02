import { t } from '../../i18n';
import { EmptyState } from '../../kit';
import { useEnv } from '../../api/useEnv';

/** Shell and attach need an upgraded connection; the Portainer agent does not carry one (the core answers 501). */
export function NoTerminal({ what }: { what: 'shell' | 'attach' }) {
  const { info } = useEnv();
  return (
    <div className="dk-card">
      <EmptyState
        icon="terminal"
        hue="term"
        title={t(`container.noTerminal.${what}`)}
        text={t('container.noTerminal.text', { env: info?.name ?? '' })}
      />
    </div>
  );
}
