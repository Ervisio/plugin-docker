/**
 * Template catalog: our own (plugin/templates.json, signed with the plugin), the user's custom templates (shared in
 * /opt/stacks/.templates), plus Portainer-format lists the user adds. Portainer v2 and v3 JSON are both read. Remote
 * lists are fetched with fetch(); the plugin frame may only reach the hosts in capabilities.network
 * (raw.githubusercontent.com and gist.githubusercontent.com).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSdk } from '../sdk';
import { useFile, type TemplateSource } from '../settings';
import catalogFallback from '../../plugin/templates.json?raw';
import { reloadCustom, useCustomTemplates } from './customTemplates';
import { ALLOWED_HOSTS, BUILTIN_ID, CUSTOM_ID, effectiveSources, parseBuiltin, parsePortainer, type Json, type Template } from './templateModel';

export * from './templateModel';

/* ---------- fetching ---------- */

function describeFetchError(url: string, e: unknown): Error {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return new Error('This is not a valid address.');
  }
  if (!ALLOWED_HOSTS.includes(host)) return new Error(`This plugin can only reach ${ALLOWED_HOSTS.join(' and ')}, not ${host}.`);
  const msg = (e as Error)?.message ?? String(e);
  return new Error(/failed to fetch|networkerror|load failed/i.test(msg) ? `Could not reach ${host}. Check the internet connection of this machine.` : msg);
}

export async function fetchText(url: string): Promise<string> {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('This is not a valid address.');
  }
  if (!url.startsWith('https://') || !ALLOWED_HOSTS.includes(host)) throw describeFetchError(url, null);
  let r: Response;
  try {
    r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  } catch (e) {
    throw describeFetchError(url, e);
  }
  if (!r.ok) throw new Error(r.status === 404 ? `${host} answered "not found" for this address.` : `${host} answered ${r.status}.`);
  return r.text();
}

/** The compose text of a stack template. */
export async function composeOf(t: Template): Promise<string> {
  if (t.compose) return t.compose;
  if (!t.composeUrl) throw new Error('This template has no compose file this plugin can fetch. Only GitHub repositories are supported.');
  return fetchText(t.composeUrl);
}

async function loadBuiltin(): Promise<Template[]> {
  try {
    const url = await getSdk().asset('templates.json');
    const r = await fetch(url);
    if (r.ok) return parseBuiltin(await r.json());
  } catch {
    /* the frame may not fetch blob: URLs: use the copy compiled into the plugin */
  }
  return parseBuiltin(JSON.parse(catalogFallback) as Json);
}

const remote = new Map<string, Promise<Template[]>>();

function loadRemote(src: TemplateSource): Promise<Template[]> {
  let p = remote.get(src.url);
  if (!p) {
    p = fetchText(src.url).then((text) => {
      let doc: Json;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new Error('The address did not return JSON.');
      }
      return parsePortainer(doc, { id: src.id, name: src.name });
    });
    remote.set(src.url, p);
    p.catch(() => remote.delete(src.url));
  }
  return p;
}

let builtin: Promise<Template[]> | undefined;

export interface SourceStatus {
  id: string;
  name: string;
  count: number;
  error?: string;
}

export interface TemplateCatalog {
  templates: Template[];
  sources: SourceStatus[];
  loading: boolean;
  reload(): void;
}

/** All templates of the enabled sources. Our own catalog loads first; remote lists arrive when they can. */
export function useTemplates(): TemplateCatalog {
  const [file] = useFile('templates-sources');
  const [state, setState] = useState<{ templates: Template[]; sources: SourceStatus[]; loading: boolean }>({ templates: [], sources: [], loading: true });
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(effectiveSources(file.sources).map((s) => [s.id, s.url, s.enabled]));

  useEffect(() => {
    let live = true;
    const sources = effectiveSources(file.sources).filter((s) => s.enabled);
    if (tick > 0) {
      for (const s of sources) remote.delete(s.url);
      builtin = undefined;
    }
    (async () => {
      builtin ??= loadBuiltin();
      const own = await builtin;
      if (!live) return;
      const status: SourceStatus[] = [{ id: BUILTIN_ID, name: own[0]?.sourceName ?? 'Ervisio catalog', count: own.length }];
      let all = [...own];
      setState({ templates: all, sources: [...status], loading: sources.length > 0 });
      await Promise.all(
        sources.map(async (s) => {
          try {
            const list = await loadRemote(s);
            status.push({ id: s.id, name: s.name, count: list.length });
            all = [...all, ...list];
          } catch (e) {
            status.push({ id: s.id, name: s.name, count: 0, error: (e as Error).message });
          }
          if (live) setState({ templates: all, sources: [...status], loading: true });
        }),
      );
      if (live) setState({ templates: all, sources: [...status], loading: false });
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  const custom = useCustomTemplates();
  const merged = useMemo(() => {
    const sources: SourceStatus[] = [...state.sources, { id: CUSTOM_ID, name: 'Custom', count: custom.templates.length, error: custom.error }];
    return { templates: [...state.templates, ...custom.templates], sources, loading: state.loading || !custom.loaded };
  }, [state, custom.templates, custom.error, custom.loaded]);

  const reload = useCallback(() => {
    setTick((n) => n + 1);
    void reloadCustom();
  }, []);
  return { ...merged, reload };
}
