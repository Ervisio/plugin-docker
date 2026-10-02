/** Status of an environment card: from the health check the daemon runs (sdk.envs.list) and our own sample. */
import { capsOf } from './environments';
import type { CardKind } from './envList';
import type { PluginEnv } from '../sdk';

export type Health = 'ok' | 'limited' | 'off';

export const KIND_ICON: Record<CardKind, string> = { local: 'server', ervisio: 'link', ssh: 'key', 'portainer-agent': 'box', 'tcp-tls': 'lock' };
export const KIND_HUE: Record<CardKind, 'file' | 'term' | 'sw' | 'log' | 'svc'> = { local: 'file', ervisio: 'term', ssh: 'sw', 'portainer-agent': 'log', 'tcp-tls': 'svc' };

/** Why an online environment is limited: a key of the `envs.note.*` strings, or '' when nothing is missing. */
export function limitOf(kind: CardKind): '' | 'agent' | 'paired' {
  if (kind === 'portainer-agent') return 'agent';
  if (kind === 'ervisio') return 'paired';
  return '';
}

/**
 * `reachable` is the daemon's last health check (every 45 s); `answered` says whether our own call just got an answer
 * (true/false) or has not run yet (undefined). A fresh answer wins over an old failed check: "Try again" works.
 */
export function healthOf(kind: CardKind, reachable: boolean, answered: boolean | undefined): Health {
  const up = answered ?? reachable;
  if (!up) return 'off';
  return limitOf(kind) ? 'limited' : 'ok';
}

export const kindOf = (e: PluginEnv | undefined): CardKind => (e ? e.kind : 'local');
export const canTerminal = (e: PluginEnv | undefined): boolean => capsOf(e?.kind, e?.id).terminal;
