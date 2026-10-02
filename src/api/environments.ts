/**
 * The current Docker environment: this server (the default) or one of the remote hosts an administrator added in
 * Settings > Environments. Every call the plugin makes (HTTP, streams, exec, terminals, transfers) reads it from
 * here, so the views never pass an environment themselves:
 *
 *   currentEnv()            // id to pass as `env`, undefined = this server
 *   setEnv('env-1a2b3c4d')  // switch: stores, streams and caches reset
 *   const { env, info } = useEnv();   // the hook lives in useEnv.ts, so this module has no React in it
 *   withEnv({ method: 'GET', path })   // a request with the current environment added (transfers use this)
 *
 * Environments are listed by `sdk.envs.list()` (core 0.5); an older console has no `sdk.envs`, which reads as "only
 * this server".
 */
import { getSdk, type PluginEnv } from '../sdk';

export type EnvKind = PluginEnv['kind'];

/** What the current environment can do. Derived from its kind, see capsOf(). */
export interface EnvCaps {
  /** Terminal, attach and exec work (the Portainer agent drops upgraded connections: the core answers 501). */
  terminal: boolean;
  /** Streamed answers (follow logs, stats, events) arrive as they are written. The Portainer agent holds them back, so the plugin polls instead. */
  live: boolean;
  /** Compose files of managed stacks live on this machine under /opt/stacks (this server, or /opt/stacks/.envs/<id>/). */
  stacks: boolean;
  /** Where managed stacks live: '' for this server (/opt/stacks/<name>), '.envs/<id>/' for a tunnel environment. */
  stackPrefix: string;
  /** The compose files are on another machine; bind mounts name paths on the remote host. */
  remoteFiles: boolean;
}

export function capsOf(kind: EnvKind | undefined, id: string | undefined): EnvCaps {
  if (!id || !kind) return { terminal: true, live: true, stacks: true, stackPrefix: '', remoteFiles: false };
  switch (kind) {
    case 'ervisio':
      // The pairing relays calls and commands only; files stay on the other server, so its stacks cannot be edited here.
      return { terminal: true, live: true, stacks: false, stackPrefix: '', remoteFiles: false };
    case 'portainer-agent':
      return { terminal: false, live: false, stacks: true, stackPrefix: `.envs/${id}/`, remoteFiles: true };
    default:
      return { terminal: true, live: true, stacks: true, stackPrefix: `.envs/${id}/`, remoteFiles: true };
  }
}

/* ---------- the current environment ---------- */

let current: string | undefined;
let currentKind: EnvKind | undefined;
let known: PluginEnv[] = [];
let generation = 0;
const subs = new Set<() => void>();
const resets = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Id to pass as `env` to the SDK; undefined for this server. */
export const currentEnv = (): string | undefined => current;
/** Bumped on every switch. A result fetched under an older value belongs to the previous environment: drop it. */
export const envGeneration = (): number => generation;
export const currentCaps = (): EnvCaps => capsOf(currentKind, current);
/** The environment as listed, undefined for this server. */
export const currentInfo = (): PluginEnv | undefined => known.find((e) => e.id === current);

/** Adds the current environment to an SDK request (http, httpStream, download, upload). */
export function withEnv<T extends { env?: string }>(req: T): T {
  return current ? { ...req, env: current } : req;
}

/** Called after every switch, before the views render again: stores, streams and caches drop what they hold. */
export function onEnvChange(fn: () => void): () => void {
  resets.add(fn);
  return () => resets.delete(fn);
}

/** Switch environment. `undefined` (or an id that is not listed) means this server. Returns true when it changed. */
export function setEnv(id: string | undefined): boolean {
  const entry = id ? known.find((e) => e.id === id) : undefined;
  const next = entry ? id : undefined;
  if (next === current) return false;
  current = next;
  currentKind = entry?.kind;
  generation++;
  resets.forEach((f) => f());
  emit();
  return true;
}

/** Remember the listed environments. The current one is kept while it is listed and dropped (back to this server) when not. */
export function setKnownEnvs(list: PluginEnv[]): void {
  const before = knownSig();
  known = list;
  if (current && !list.some((e) => e.id === current)) {
    setEnv(undefined);
    return;
  }
  const kind = list.find((e) => e.id === current)?.kind;
  const changed = kind !== currentKind || knownSig() !== before;
  currentKind = kind;
  if (changed) emit();
}

const knownSig = (): string => known.map((e) => `${e.id}/${e.name}/${e.kind}`).join(',');

export const knownEnvs = (): PluginEnv[] => known;

/** For useEnv(): subscribe to switches and to changes of the list; the snapshot changes with either. */
export const subscribeEnv = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
export const envSnapshot = () => `${generation}:${current ?? ''}:${currentKind ?? ''}:${knownSig()}`;

/** Lists the environments the user may use. A console without environments (before core 0.5) has none. */
export async function listEnvs(): Promise<PluginEnv[]> {
  const sdk = getSdk();
  if (!sdk.envs) return [];
  const list = await sdk.envs.list();
  return Array.isArray(list) ? list : [];
}

/** Test hook: back to this server without notifying. */
export function resetEnvState(): void {
  current = undefined;
  currentKind = undefined;
  known = [];
  generation = 0;
}
