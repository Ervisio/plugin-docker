import { useSyncExternalStore } from 'react';
import type { PluginEnv } from '../sdk';
import { currentCaps, currentEnv, currentInfo, envSnapshot, knownEnvs, subscribeEnv, type EnvCaps } from './environments';

/** The current environment and what it can do; re-renders on a switch and when the list of environments changes. */
export function useEnv(): { env: string | undefined; info: PluginEnv | undefined; caps: EnvCaps; /** More than this server exists. */ multi: boolean } {
  useSyncExternalStore(subscribeEnv, envSnapshot);
  return { env: currentEnv(), info: currentInfo(), caps: currentCaps(), multi: knownEnvs().length > 0 };
}
