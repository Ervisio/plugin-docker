import { t } from '../../i18n';
import { toast } from '../../kit';

/** Copies text to the clipboard; when the browser refuses, shows it in a toast. */
export async function copyTextSafe(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.ok(t('res.copied'));
  } catch {
    toast.info(t('res.copyFailed'), text);
  }
}
