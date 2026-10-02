/**
 * Custom templates: one JSON file per template in /opt/stacks/.templates (a Portainer v3 list holding the one
 * template, see templateModel.ts). The folder sits next to the stacks, so everyone who uses this machine's Docker
 * sees the same templates. Stack listings skip it: a stack name cannot start with a dot.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { ensureStacksFolder, fsx, STACKS_DIR } from './compose';
import { CUSTOM_FILE_RE, newFileId, parseCustomFile, templateFileText, type Template } from './templateModel';

export const TEMPLATES_DIR = `${STACKS_DIR}/.templates`;

export interface CustomState {
  templates: Template[];
  /** Files that are not usable templates. */
  broken: { file: string; message: string }[];
  /** The folder could not be read (for example no access). */
  error?: string;
  loaded: boolean;
}

let state: CustomState = { templates: [], broken: [], loaded: false };
let inflight: Promise<void> | undefined;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const set = (s: CustomState) => {
  state = s;
  emit();
};

const notFound = (e: unknown): boolean => /not_found|no such file|not exist|not found|ENOENT/i.test(`${(e as { code?: string })?.code ?? ''} ${(e as Error)?.message ?? ''}`);

/** Reads the folder again. */
export function reloadCustom(): Promise<void> {
  inflight ??= (async () => {
    try {
      let entries;
      try {
        entries = await fsx.list(TEMPLATES_DIR);
      } catch (e) {
        if (notFound(e)) return set({ templates: [], broken: [], loaded: true });
        throw e;
      }
      const templates: Template[] = [];
      const broken: CustomState['broken'] = [];
      await Promise.all(
        entries
          .filter((e) => e.type === 'file' && e.name.endsWith('.json'))
          .map(async (e) => {
            const file = e.name.slice(0, -5);
            if (!CUSTOM_FILE_RE.test(file)) return;
            try {
              templates.push(parseCustomFile(file, await fsx.read(`${TEMPLATES_DIR}/${e.name}`)));
            } catch (err) {
              broken.push({ file, message: (err as Error).message });
            }
          }),
      );
      templates.sort((a, b) => a.name.localeCompare(b.name));
      set({ templates, broken, loaded: true });
    } catch (e) {
      set({ templates: [], broken: [], error: (e as Error).message, loaded: true });
    }
  })().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

/** The custom templates, loaded once and shared. */
export function useCustomTemplates(): CustomState & { reload(): Promise<void> } {
  const s = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
  useEffect(() => {
    if (!state.loaded) void reloadCustom();
  }, []);
  return { ...s, reload: reloadCustom };
}

export const customTemplates = (): Template[] => state.templates;

/**
 * Saves a template. With `file` the existing file is replaced; without it a new file is made from the title.
 * Creates /opt/stacks and the templates folder when they are missing. Returns the saved template.
 */
export async function saveCustomTemplate(t: Template, file?: string): Promise<Template> {
  await ensureStacksFolder();
  try {
    await fsx.mkdir(TEMPLATES_DIR);
  } catch (e) {
    if (!/exist/i.test((e as Error).message ?? '')) {
      try {
        await fsx.list(TEMPLATES_DIR);
      } catch {
        throw e;
      }
    }
  }
  if (!state.loaded) await reloadCustom();
  const id = file ?? newFileId(t.name, state.templates.map((x) => x.custom?.file ?? ''));
  const now = new Date().toISOString();
  const saved: Template = { ...t, id: `custom:${id}`, source: 'custom', sourceName: 'Custom', custom: { file: id, created: t.custom?.created ?? now, updated: now } };
  await fsx.write(`${TEMPLATES_DIR}/${id}.json`, templateFileText(saved));
  set({ ...state, templates: [...state.templates.filter((x) => x.custom?.file !== id), saved].sort((a, b) => a.name.localeCompare(b.name)) });
  return saved;
}

export async function deleteCustomTemplate(file: string): Promise<void> {
  if (!CUSTOM_FILE_RE.test(file)) throw new Error('Invalid template name');
  await fsx.remove(`${TEMPLATES_DIR}/${file}.json`);
  set({ ...state, templates: state.templates.filter((x) => x.custom?.file !== file) });
}

/** A copy under a new title, saved as a new file. */
export async function duplicateCustomTemplate(t: Template, title: string): Promise<Template> {
  return saveCustomTemplate({ ...t, name: title, custom: undefined });
}
