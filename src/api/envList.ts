/** The environments the user may use (sdk.envs.list), shared and refreshed every 30 seconds while a view uses it. */
import { listEnvs, setKnownEnvs } from './environments';
import type { PluginEnv } from '../sdk';
import { createResource } from './store';

export const envList = createResource<PluginEnv[]>(
  async () => {
    const list = await listEnvs();
    setKnownEnvs(list);
    return list;
  },
  { intervalMs: 30000, global: true },
);

/** Kinds as the UI names them. */
export type CardKind = PluginEnv['kind'] | 'local';

/** Opens Settings > Environments of the core in a new tab: the frame cannot navigate the app, but it knows its own address. */
export function coreEnvSettingsUrl(href: string = typeof location === 'undefined' ? '' : location.href): string {
  try {
    return new URL('/settings#envlist', href).toString();
  } catch {
    return '/settings#envlist';
  }
}
