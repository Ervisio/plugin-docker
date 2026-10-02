/**
 * The template model, pure (no SDK, no React) so tests can import it: the types, reading our catalog and Portainer
 * v2 / v3 lists, the values a form starts with, and the text of a stack's .env.
 */
import type { TemplateSource } from '../settings';
import { formatValue } from './dotenv.ts';

export type HueName = 'ov' | 'term' | 'file' | 'log' | 'svc' | 'sw' | 'usr' | 'plg';
export const HUES: HueName[] = ['ov', 'term', 'file', 'log', 'svc', 'sw', 'usr', 'plg'];

export interface TemplateVar {
  name: string;
  label: string;
  default: string;
  type: 'text' | 'password' | 'port' | 'path' | 'bool';
  required?: boolean;
  hint?: string;
  /** Fill with a random value (passwords). */
  generate?: boolean;
  /** A fixed list of choices (Portainer's `select`): shown as a drop-down. The default is the value to start with. */
  options?: { label: string; value: string }[];
}

export interface ContainerTemplate {
  image: string;
  ports: { host: string; container: string; proto: string }[];
  volumes: { source: string; target: string; readOnly?: boolean }[];
  env: { key: string; value: string }[];
  restart?: string;
  command?: string;
  hostname?: string;
  network?: string;
  privileged?: boolean;
  labels?: { key: string; value: string }[];
}

export interface Template {
  /** Unique over all sources: "<source>:<id>". */
  id: string;
  source: string;
  sourceName: string;
  name: string;
  description: string;
  category: string;
  hue: HueName;
  type: 'container' | 'stack';
  featured: boolean;
  website?: string;
  note?: string;
  needs?: { ports?: (number | string)[]; ram?: string; disk?: string; containers?: number; note?: string };
  variables: TemplateVar[];
  container?: ContainerTemplate;
  /** Compose text, for stacks of our own catalog. */
  compose?: string;
  /** Where to fetch the compose text (raw URL), for Portainer stacks. */
  composeUrl?: string;
  /** Values written to the .env file without asking. */
  fixedEnv?: { key: string; value: string }[];
  /** A Docker Swarm stack that is run as plain compose. */
  swarm?: boolean;
  /** All categories (Portainer templates have several); `category` is the first. */
  categories?: string[];
  /** Logo address, kept for Portainer compatibility. The plugin frame cannot load images from the web, so it is not drawn. */
  logo?: string;
  /** Set on custom templates (saved in /opt/stacks/.templates). */
  custom?: { file: string; created?: string; updated?: string };
}

/** Id of the plugin's own catalog (templates.json "source"). An identifier, kept from Ervisio's former name. */
export const BUILTIN_ID = 'linuxadmin';
export const DEFAULT_SOURCE: TemplateSource = {
  id: 'portainer',
  name: 'Portainer templates',
  url: 'https://raw.githubusercontent.com/portainer/templates/v3/templates.json',
  enabled: true,
};
/** The hosts of capabilities.network in manifest.json. */
export const ALLOWED_HOSTS = ['raw.githubusercontent.com', 'gist.githubusercontent.com'];

/** The saved list, or the default one when nothing was saved yet. */
export const effectiveSources = (saved: TemplateSource[]): TemplateSource[] => (saved.length ? saved : [DEFAULT_SOURCE]);

export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'app';

export function hueFor(name: string): HueName {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

/* ---------- values ---------- */

export function randomSecret(len = 22): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function initialValues(vars: TemplateVar[]): Record<string, string> {
  const v: Record<string, string> = {};
  for (const x of vars) v[x.name] = x.generate && !x.default ? randomSecret() : x.default;
  return v;
}

/** Replaces ${NAME} with the values. Unknown names become empty. */
export const substitute = (text: string, values: Record<string, string>): string => text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => values[n] ?? '');

export function containerPrefill(c: ContainerTemplate, values: Record<string, string>, name: string) {
  const s = (x: string) => substitute(x, values);
  return {
    name,
    ports: c.ports.map((p) => ({ host: s(p.host), container: s(p.container), proto: p.proto })).filter((p) => p.container),
    volumes: c.volumes.map((v) => ({ source: s(v.source), target: s(v.target), readOnly: v.readOnly })).filter((v) => v.source && v.target),
    env: c.env.map((e) => ({ key: e.key, value: s(e.value) })).filter((e) => e.value !== '' || /^(true|false)$/.test(e.value)),
    restart: c.restart,
    network: c.network,
    hostname: c.hostname,
    command: c.command ? s(c.command) : undefined,
    privileged: c.privileged,
    labels: c.labels,
  };
}

/** Template values are literal text: single quotes keep `$` and `#` as they are (see api/dotenv.ts). */
const envQuote = (v: string): string => formatValue(v, 'single');

/** Text of the .env file of a stack. */
export function envText(values: Record<string, string>, vars: TemplateVar[], fixed: { key: string; value: string }[] = []): string {
  const lines = vars.map((v) => `${v.name}=${envQuote(values[v.name] ?? '')}`);
  for (const f of fixed) if (!vars.some((v) => v.name === f.key)) lines.push(`${f.key}=${envQuote(f.value)}`);
  return lines.join('\n') + '\n';
}

/* ---------- reading lists ---------- */

export type Json = Record<string, any>;

export const stripHtml = (s: unknown): string => (typeof s === 'string' ? s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '');

export function parseBuiltin(doc: Json): Template[] {
  const out: Template[] = [];
  for (const raw of (doc.templates ?? []) as Json[]) {
    if (!raw.id || !raw.name || (raw.type !== 'container' && raw.type !== 'stack')) continue;
    out.push({
      id: `${BUILTIN_ID}:${raw.id}`,
      source: BUILTIN_ID,
      sourceName: String(doc.name ?? 'Ervisio catalog'),
      name: raw.name,
      description: raw.description ?? '',
      category: raw.category ?? 'Other',
      hue: HUES.includes(raw.hue) ? raw.hue : hueFor(raw.name),
      type: raw.type,
      featured: !!raw.featured,
      website: raw.website,
      needs: raw.needs,
      variables: raw.variables ?? [],
      container: raw.container,
      compose: raw.compose,
    });
  }
  return out;
}

export function parsePorts(list: unknown): ContainerTemplate['ports'] {
  const out: ContainerTemplate['ports'] = [];
  for (const entry of Array.isArray(list) ? list : []) {
    // "80/tcp", "8080:80/tcp", "8080:80"
    const m = /^(?:(\d+):)?(\d+)(?:\/(tcp|udp))?$/i.exec(String(entry).trim());
    if (m) out.push({ host: m[1] ?? m[2], container: m[2], proto: (m[3] ?? 'tcp').toLowerCase() });
  }
  return out;
}

function portainerVars(env: unknown): { vars: TemplateVar[]; fixed: { key: string; value: string }[] } {
  const vars: TemplateVar[] = [];
  const fixed: { key: string; value: string }[] = [];
  const TYPES = ['text', 'password', 'port', 'path', 'bool'];
  for (const e of Array.isArray(env) ? (env as Json[]) : []) {
    if (!e?.name) continue;
    const options = (Array.isArray(e.select) ? (e.select as Json[]) : [])
      .filter((o) => o && o.value !== undefined && o.value !== null)
      .map((o) => ({ label: String(o.text ?? o.value), value: String(o.value), def: !!o.default }));
    const def = e.default !== undefined ? String(e.default) : options.find((o) => o.def)?.value ?? options[0]?.value ?? '';
    if (e.label && !e.preset) {
      const ext = (e.ervisio ?? {}) as Json;
      const secret = /pass|secret|token|key/i.test(e.name);
      const type = TYPES.includes(ext.type) ? ext.type : secret ? 'password' : 'text';
      vars.push({
        name: e.name,
        label: e.label,
        default: def,
        type,
        required: ext.required === true,
        hint: stripHtml(e.description) || undefined,
        generate: ext.generate !== undefined ? ext.generate === true : secret && !def,
        options: options.length ? options.map((o) => ({ label: o.label, value: o.value })) : undefined,
      });
    } else if (def !== '') fixed.push({ key: e.name, value: def });
  }
  return { vars, fixed };
}

export function githubRaw(repoUrl: string, file: string): string | undefined {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl.trim());
  if (!m) return undefined;
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/${file.replace(/^\/+/, '')}`;
}

export function parsePortainer(doc: Json, src: { id: string; name: string }): Template[] {
  const out: Template[] = [];
  const list: Json[] = Array.isArray(doc) ? doc : doc.templates;
  if (!Array.isArray(list)) throw new Error('This is not a Portainer template list (no "templates" array).');
  list.forEach((raw, idx) => {
    const kind = Number(raw?.type);
    if (!raw || !raw.title || ![1, 2, 3].includes(kind)) return;
    if (raw.platform && String(raw.platform).toLowerCase() === 'windows') return;
    const base = {
      id: `${src.id}:${raw.id ?? idx}`,
      source: src.id,
      sourceName: src.name,
      name: String(raw.title),
      description: stripHtml(raw.description),
      category: String(raw.categories?.[0] ?? 'Other').replace(/^./, (c: string) => c.toUpperCase()),
      hue: HUES.includes(raw.ervisio?.hue) ? raw.ervisio.hue : hueFor(String(raw.title)),
      featured: false,
      note: stripHtml(raw.note) || undefined,
      logo: typeof raw.logo === 'string' && raw.logo ? raw.logo : undefined,
      categories: Array.isArray(raw.categories) ? raw.categories.map(String) : undefined,
    };
    const { vars, fixed } = portainerVars(raw.env);
    if (kind === 1) {
      if (!raw.image) return;
      const key = slug(raw.title);
      const volumes = (Array.isArray(raw.volumes) ? (raw.volumes as Json[]) : [])
        .filter((v) => v?.container)
        .map((v, n) => ({ source: v.bind ? String(v.bind) : `${key}-${slug(String(v.container).split('/').pop() || `data-${n}`)}`, target: String(v.container), readOnly: !!v.readonly }));
      const env = [
        ...vars.map((v) => ({ key: v.name, value: `\${${v.name}}` })),
        ...fixed,
      ];
      out.push({
        ...base,
        type: 'container',
        variables: vars,
        needs: { ports: parsePorts(raw.ports).map((p) => Number(p.host)) },
        container: {
          image: String(raw.image),
          ports: parsePorts(raw.ports),
          volumes,
          env,
          restart: raw.restart_policy && ['no', 'always', 'unless-stopped', 'on-failure'].includes(raw.restart_policy) ? raw.restart_policy : 'unless-stopped',
          command: raw.command ? String(raw.command) : undefined,
          hostname: raw.hostname,
          network: raw.network && typeof raw.network === 'string' ? raw.network : undefined,
          privileged: !!raw.privileged,
          labels: (Array.isArray(raw.labels) ? (raw.labels as Json[]) : []).filter((l) => l?.name).map((l) => ({ key: String(l.name), value: String(l.value ?? '') })),
        },
      });
    } else {
      const repo = raw.repository;
      const composeUrl = repo?.url && repo?.stackfile ? githubRaw(String(repo.url), String(repo.stackfile)) : undefined;
      const own = typeof raw.ervisio?.compose === 'string' ? (raw.ervisio.compose as string) : undefined;
      out.push({ ...base, type: 'stack', variables: vars, fixedEnv: fixed, compose: own, composeUrl: own ? undefined : composeUrl, swarm: kind === 2, needs: undefined });
    }
  });
  return out;
}


/* ---------- custom templates: the file format ---------- */

/** Id of the custom templates "source": a template's id is `custom:<file>`, the file being <file>.json. */
export const CUSTOM_ID = 'custom';
export const CUSTOM_FILE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Version of the Ervisio additions inside a template file (the `ervisio` key). */
export const CUSTOM_FORMAT = 1;

const volumeEntry = (v: { source: string; target: string; readOnly?: boolean }): Json => {
  const bind = /^[/~.]/.test(v.source);
  return { container: v.target, ...(bind ? { bind: v.source } : {}), ...(v.readOnly ? { readonly: true } : {}) };
};

/**
 * One template as a Portainer v3 entry, so Portainer-format readers (our importer, and Portainer itself for the
 * container kind) can use it. Ervisio-only data lives under an `ervisio` key that other readers ignore: the compose
 * text of a stack (Portainer templates point to a Git repository instead), the colour, and the kind of each variable.
 */
export function templateToEntry(t: Template): Json {
  const entry: Json = {
    type: t.type === 'container' ? 1 : 3,
    title: t.name,
    description: t.description,
    ...(t.logo ? { logo: t.logo } : {}),
    categories: t.categories?.length ? t.categories : [t.category],
    platform: 'linux',
    ...(t.note ? { note: t.note } : {}),
  };
  const asked = new Set(t.variables.map((v) => v.name));
  const env: Json[] = t.variables.map((v) => ({
    name: v.name,
    label: v.label,
    ...(v.default !== '' ? { default: v.default } : {}),
    ...(v.hint ? { description: v.hint } : {}),
    ...(v.options?.length ? { select: v.options.map((o) => ({ text: o.label, value: o.value, ...(o.value === v.default ? { default: true } : {}) })) } : {}),
    ervisio: { type: v.type, required: !!v.required, generate: !!v.generate },
  }));
  if (t.type === 'container' && t.container) {
    const c = t.container;
    entry.image = c.image;
    entry.ports = c.ports.map((p) => `${p.host ? `${p.host}:` : ''}${p.container}/${p.proto || 'tcp'}`);
    entry.volumes = c.volumes.map(volumeEntry);
    if (c.restart) entry.restart_policy = c.restart;
    if (c.command) entry.command = c.command;
    if (c.hostname) entry.hostname = c.hostname;
    if (c.network) entry.network = c.network;
    if (c.privileged) entry.privileged = true;
    if (c.labels?.length) entry.labels = c.labels.map((l) => ({ name: l.key, value: l.value }));
    for (const e of c.env) {
      const ref = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(e.value);
      if (ref && asked.has(ref[1]) && ref[1] === e.key) continue;
      env.push({ name: e.key, default: e.value, preset: true });
    }
  } else {
    for (const f of t.fixedEnv ?? []) env.push({ name: f.key, default: f.value, preset: true });
  }
  if (env.length) entry.env = env;
  const meta: Json = { format: CUSTOM_FORMAT, hue: t.hue };
  if (t.type === 'stack') meta.compose = t.compose ?? '';
  if (t.custom?.created) meta.created = t.custom.created;
  if (t.custom?.updated) meta.updated = t.custom.updated;
  entry.ervisio = meta;
  return entry;
}

/** The text of a template file: a Portainer v3 list with this one template in it. */
export const templateFileText = (t: Template): string => JSON.stringify({ version: '3', templates: [templateToEntry(t)] }, null, 2) + '\n';

/** Entries of pasted or uploaded JSON: a Portainer list (v2 or v3), a bare array, or a single entry. */
export function entriesOf(text: string): Json[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('This is not valid JSON.');
  }
  const list = Array.isArray(doc) ? doc : doc && typeof doc === 'object' && Array.isArray((doc as Json).templates) ? (doc as Json).templates : doc && typeof doc === 'object' && (doc as Json).title ? [doc] : null;
  if (!list) throw new Error('This is not a template. Expected a Portainer template list or one template with a "title".');
  return list as Json[];
}

/** Templates of an entry list as custom templates (not yet saved: `custom.file` is empty). Entries Ervisio cannot use are counted in `skipped`. */
export function importTemplates(text: string): { templates: Template[]; skipped: number } {
  const entries = entriesOf(text);
  const out: Template[] = [];
  for (const e of entries) {
    const got = parsePortainer({ templates: [e] }, { id: CUSTOM_ID, name: 'Custom' })[0];
    if (!got) continue;
    out.push({ ...got, id: '', source: CUSTOM_ID, sourceName: 'Custom', custom: { file: '', created: e.ervisio?.created, updated: e.ervisio?.updated } });
  }
  return { templates: out, skipped: entries.length - out.length };
}

/** A template file read from disk. Throws a readable error when it is not one. */
export function parseCustomFile(file: string, text: string): Template {
  const { templates } = importTemplates(text);
  const t = templates[0];
  if (!t) throw new Error('No usable template in this file.');
  return { ...t, id: `${CUSTOM_ID}:${file}`, custom: { ...t.custom, file } };
}

/** A free file name (without .json) for a title. */
export function newFileId(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slug(title).replace(/^-+/, '').slice(0, 50) || 'template';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}
