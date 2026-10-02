/**
 * The custom template editor's form: a flat set of strings, converted to and from a Template. Pure (no SDK).
 * One table of environment variables serves both kinds: a stack writes them to its .env, a container passes them
 * with -e. A variable is either "asked" (shown in the install form) or fixed (written without asking).
 */
import { parseRows } from './dotenv.ts';
import { slug, hueFor, type ContainerTemplate, type HueName, type Template, type TemplateVar } from './templateModel.ts';

export interface EnvForm {
  id: string;
  name: string;
  value: string;
  ask: boolean;
  label: string;
  hint: string;
  type: TemplateVar['type'];
  required: boolean;
  generate: boolean;
  /** One choice per line: `Label=value`, or just the value. */
  options: string;
}

export interface TemplateForm {
  name: string;
  description: string;
  logo: string;
  note: string;
  /** Comma separated. */
  categories: string;
  type: 'container' | 'stack';
  compose: string;
  image: string;
  /** One per line: `8080:80/tcp`, `80`. */
  ports: string;
  /** One per line: `source:target[:ro]`, or just `/target` (a named volume is made for it). */
  volumes: string;
  restart: string;
  command: string;
  hostname: string;
  network: string;
  privileged: boolean;
  /** One per line: `key=value`. */
  labels: string;
  env: EnvForm[];
  hue: HueName;
}

export interface FormProblem {
  /** Which field: a TemplateForm key, or `env:<id>`. */
  field: string;
  /** i18n key (templates.edit.err.*). */
  key: string;
  vars?: Record<string, string | number>;
}

let seq = 0;
export const newEnvForm = (p: Partial<EnvForm> = {}): EnvForm => ({ id: `v${++seq}`, name: '', value: '', ask: false, label: '', hint: '', type: 'text', required: false, generate: false, options: '', ...p });

export const emptyForm = (type: 'container' | 'stack' = 'stack'): TemplateForm => ({
  name: '', description: '', logo: '', note: '', categories: '', type, compose: type === 'stack' ? 'services:\n  app:\n    image: nginx:alpine\n    ports:\n      - "${HTTP_PORT}:80"\n    restart: unless-stopped\n' : '',
  image: '', ports: '', volumes: '', restart: 'unless-stopped', command: '', hostname: '', network: '', privileged: false, labels: '', env: [], hue: 'file',
});

const optionsText = (v: TemplateVar): string => (v.options ?? []).map((o) => (o.label === o.value ? o.value : `${o.label}=${o.value}`)).join('\n');

export function formFromTemplate(t: Template): TemplateForm {
  const f = emptyForm(t.type);
  f.name = t.name;
  f.description = t.description;
  f.logo = t.logo ?? '';
  f.note = t.note ?? '';
  f.categories = (t.categories?.length ? t.categories : t.category && t.category !== 'Other' ? [t.category] : []).join(', ');
  f.compose = t.compose ?? '';
  f.hue = t.hue;
  const asked = new Set(t.variables.map((v) => v.name));
  f.env = t.variables.map((v) => newEnvForm({ name: v.name, value: v.default, ask: true, label: v.label, hint: v.hint ?? '', type: v.type, required: !!v.required, generate: !!v.generate, options: optionsText(v) }));
  const fixed = t.type === 'container' ? (t.container?.env ?? []).filter((e) => !(asked.has(e.key) && e.value === `\${${e.key}}`)) : (t.fixedEnv ?? []);
  for (const e of fixed) f.env.push(newEnvForm({ name: e.key, value: e.value }));
  if (t.container) {
    const c = t.container;
    f.image = c.image;
    f.ports = c.ports.map((p) => `${p.host ? `${p.host}:` : ''}${p.container}/${p.proto || 'tcp'}`).join('\n');
    f.volumes = c.volumes.map((v) => `${v.source}:${v.target}${v.readOnly ? ':ro' : ''}`).join('\n');
    f.restart = c.restart ?? '';
    f.command = c.command ?? '';
    f.hostname = c.hostname ?? '';
    f.network = c.network ?? '';
    f.privileged = !!c.privileged;
    f.labels = (c.labels ?? []).map((l) => `${l.key}=${l.value}`).join('\n');
  }
  return f;
}

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);

export function parsePortLine(l: string): ContainerTemplate['ports'][number] | null {
  const m = /^(?:(\d{1,5}|\$\{[A-Za-z_][A-Za-z0-9_]*\}):)?(\d{1,5}|\$\{[A-Za-z_][A-Za-z0-9_]*\})(?:\/(tcp|udp))?$/i.exec(l);
  if (!m) return null;
  return { host: m[1] ?? m[2], container: m[2], proto: (m[3] ?? 'tcp').toLowerCase() };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function templateFromForm(f: TemplateForm, prev?: Template): { template?: Template; problems: FormProblem[] } {
  const problems: FormProblem[] = [];
  const bad = (field: string, key: string, vars?: FormProblem['vars']) => problems.push({ field, key, vars });
  const name = f.name.trim();
  if (!name) bad('name', 'templates.edit.err.title');
  const categories = f.categories.split(',').map((c) => c.trim()).filter(Boolean);
  if (f.logo.trim() && !/^https?:\/\//i.test(f.logo.trim())) bad('logo', 'templates.edit.err.logo');

  const seen = new Set<string>();
  const variables: TemplateVar[] = [];
  const fixed: { key: string; value: string }[] = [];
  for (const e of f.env) {
    if (!e.name.trim() && !e.value && !e.label) continue;
    const n = e.name.trim();
    const field = `env:${e.id}`;
    if (!ENV_NAME.test(n)) {
      bad(field, 'templates.edit.err.envName');
      continue;
    }
    if (seen.has(n)) {
      bad(field, 'templates.edit.err.envDup', { name: n });
      continue;
    }
    seen.add(n);
    if (!e.ask) {
      fixed.push({ key: n, value: e.value });
      continue;
    }
    const options = lines(e.options).map((l) => {
      const i = l.indexOf('=');
      return i > 0 ? { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() } : { label: l, value: l };
    });
    if (options.length && e.value && !options.some((o) => o.value === e.value)) bad(field, 'templates.edit.err.optDefault', { name: n });
    variables.push({
      name: n,
      label: e.label.trim() || n,
      default: e.value,
      type: e.type,
      required: e.required,
      hint: e.hint.trim() || undefined,
      generate: e.type === 'password' && e.generate,
      options: options.length ? options : undefined,
    });
  }

  const base: Template = {
    id: prev?.id ?? '',
    source: 'custom',
    sourceName: 'Custom',
    name,
    description: f.description.trim(),
    category: categories[0] ?? 'Other',
    categories,
    hue: prev?.hue ?? (name ? hueFor(name) : f.hue),
    type: f.type,
    featured: false,
    note: f.note.trim() || undefined,
    logo: f.logo.trim() || undefined,
    variables,
    custom: prev?.custom,
  };

  if (f.type === 'stack') {
    if (!f.compose.trim()) bad('compose', 'templates.edit.err.compose');
    base.compose = f.compose.endsWith('\n') ? f.compose : f.compose + '\n';
    base.fixedEnv = fixed;
  } else {
    const image = f.image.trim();
    if (!image) bad('image', 'templates.edit.err.image');
    const ports: ContainerTemplate['ports'] = [];
    for (const l of lines(f.ports)) {
      const p = parsePortLine(l);
      if (p) ports.push(p);
      else bad('ports', 'templates.edit.err.port', { line: l });
    }
    const volumes: ContainerTemplate['volumes'] = [];
    for (const l of lines(f.volumes)) {
      const parts = l.split(':');
      const ro = parts[parts.length - 1] === 'ro';
      if (ro) parts.pop();
      if (parts.length === 1 && parts[0].startsWith('/')) volumes.push({ source: `${slug(name) || 'app'}-${slug(parts[0].split('/').filter(Boolean).pop() ?? 'data')}`, target: parts[0], readOnly: ro || undefined });
      else if (parts.length === 2 && parts[0] && parts[1].startsWith('/')) volumes.push({ source: parts[0], target: parts[1], readOnly: ro || undefined });
      else bad('volumes', 'templates.edit.err.volume', { line: l });
    }
    const labels: { key: string; value: string }[] = [];
    for (const l of lines(f.labels)) {
      const i = l.indexOf('=');
      if (i > 0) labels.push({ key: l.slice(0, i).trim(), value: l.slice(i + 1) });
      else bad('labels', 'templates.edit.err.label', { line: l });
    }
    base.container = {
      image,
      ports,
      volumes,
      env: [...variables.map((v) => ({ key: v.name, value: `\${${v.name}}` })), ...fixed],
      restart: f.restart || undefined,
      command: f.command.trim() || undefined,
      hostname: f.hostname.trim() || undefined,
      network: f.network.trim() || undefined,
      privileged: f.privileged || undefined,
      labels: labels.length ? labels : undefined,
    };
    base.needs = ports.length ? { ports: ports.map((p) => (/^\d+$/.test(p.host) ? Number(p.host) : p.host)) } : undefined;
  }
  return problems.length ? { problems } : { template: base, problems };
}

/* ---------- seeds: a template to start from ---------- */

const SECRET = /pass|secret|token|key|pwd|credential/i;

/** A stack template from a managed stack's files. Secret values are left out and asked for at install. */
export function seedFromStack(name: string, compose: string, env: string): Template {
  const variables: TemplateVar[] = [];
  const seen = new Set<string>();
  for (const r of parseRows(env).rows) {
    if (r.kind !== 'var' || seen.has(r.key) || !ENV_NAME.test(r.key)) continue;
    seen.add(r.key);
    const secret = SECRET.test(r.key);
    variables.push({ name: r.key, label: r.key, default: secret ? '' : r.value, type: secret ? 'password' : 'text', required: false, generate: secret });
  }
  return { id: '', source: 'custom', sourceName: 'Custom', name, description: '', category: 'Other', hue: hueFor(name), type: 'stack', featured: false, variables, compose, fixedEnv: [] };
}
