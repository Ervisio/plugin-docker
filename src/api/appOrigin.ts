import { getSdk } from '../sdk';

/**
 * The address of the Ervisio app. A plugin frame has an opaque origin, so use sdk.appOrigin (core 0.5.0); on an older
 * console fall back to what the browser says about the parent.
 */
export function appOrigin(): string {
  try {
    const o = getSdk().appOrigin;
    if (o && o !== 'null') return o.replace(/\/+$/, '');
  } catch { /* no SDK yet */ }
  if (typeof location === 'undefined') return '';
  try {
    const anc = (location as unknown as { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    if (anc && anc.length && anc[0] && anc[0] !== 'null') return anc[0];
  } catch { /* not Chromium */ }
  try {
    if (document.referrer) return new URL(document.referrer).origin;
  } catch { /* none */ }
  return location.origin && location.origin !== 'null' ? location.origin : '';
}
