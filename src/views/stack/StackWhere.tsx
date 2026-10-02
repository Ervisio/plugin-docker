import { stacksRoot } from '../../api/compose';
import { useEnv } from '../../api/useEnv';
import { t } from '../../i18n';
import { Icon } from '../../kit';

/**
 * Where the files of a stack are when the open environment is a remote host: tunnel kinds keep them on this server
 * (and their bind mounts name folders on the host), a paired Ervisio server keeps them on itself.
 * Renders nothing on this server.
 */
export function StackWhere({ binds = true }: { binds?: boolean }) {
  const { info, caps } = useEnv();
  if (!info) return null;
  if (caps.pairedFiles) {
    return (
      <div className="dk-ev-where" role="note">
        <Icon name="info" />
        <span>{t('envs.stack.pairedFiles', { env: info.name, dir: stacksRoot() })}{binds && <> {t('envs.stack.pairedBinds', { env: info.name })}</>}</span>
      </div>
    );
  }
  if (!caps.stacks) {
    return (
      <div className="dk-ev-where dk-ev-where--warn" role="note">
        <Icon name="info" />
        <span>{t('envs.stack.paired', { env: info.name })}</span>
      </div>
    );
  }
  return (
    <div className="dk-ev-where" role="note">
      <Icon name="info" />
      <span>
        {t('envs.stack.tunnel', { env: info.name, dir: stacksRoot() })}
        {binds && <> {t('envs.stack.binds', { env: info.name })}</>}
      </span>
    </div>
  );
}
