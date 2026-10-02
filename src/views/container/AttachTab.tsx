import { t } from '../../i18n';
import { Button, EmptyState } from '../../kit';
import { navigate } from '../../router';
import { ShellTab } from './ShellTab';

/**
 * Attach to the main process (docker attach). Docker can send keystrokes only when the container was created with
 * stdin open, so without it this explains why and offers the way out (edit and recreate).
 */
export function AttachTab({ id, running, visible, onStart, openStdin, tty }: { id: string; running: boolean; visible: boolean; onStart(): void; openStdin: boolean; tty: boolean }) {
  if (!openStdin) {
    return (
      <div className="dk-card">
        <EmptyState
          icon="terminal"
          hue="term"
          title={t('container.attach.no.title')}
          text={t('container.attach.no.text')}
          action={<Button variant="primary" icon="edit" onClick={() => navigate({ view: 'create', from: id })}>{t('container.edit')}</Button>}
        />
      </div>
    );
  }
  return <ShellTab id={id} running={running} visible={visible} onStart={onStart} mode="attach" tty={tty} />;
}
