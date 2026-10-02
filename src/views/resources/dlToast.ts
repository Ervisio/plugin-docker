import type { DownloadResult } from '../../sdk';
import { describeDone } from '../../api/downloads';
import { t } from '../../i18n';
import { toast } from '../../kit';

/** The toast for the end of a download. Nothing when the daemon sent no result (the fallback timer ended the wait). */
export function toastDone(name: string, r: DownloadResult | undefined): void {
  const d = describeDone(r);
  if (!d) return;
  if (d.ok) toast.ok(t('dl.done', { name, size: d.size }));
  else toast.err(t('dl.fail', { name }), d.error ? t('dl.failWhy', { why: d.error, size: d.size }) : t('dl.failHint'));
}
