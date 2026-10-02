/**
 * Backup of the plugin settings: the format, building it, reading it back and planning an import. Pure (no SDK).
 *
 * One JSON file, versioned. Version 1 holds:
 *   registries       saved registry logins (passwords optional)
 *   customTemplates  the shared templates of /opt/stacks/.templates, each as its Portainer v3 file
 *   templateSources  extra template lists
 *   alertRules       alert rules (not the alert history)
 *   autoUpdate       the auto-update settings
 *   preferences      the plugin's general settings
 * An import merges: items are matched by a key (see KEYS), matches are replaced, the rest added. Nothing is removed.
 */
import type { AlertRule, AutoUpdateConfig, Registry, Settings, TemplateSource } from '../settings';

export const BACKUP_FORMAT = 'ervisio-docker-settings';
export const BACKUP_VERSION = 1;

export interface BackupTemplate {
  /** File name without .json. */
  file: string;
  /** The template file's content (a Portainer v3 list). */
  doc: unknown;
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  /** False when the registry passwords were left out. */
  includesPasswords: boolean;
  registries: Registry[];
  customTemplates: BackupTemplate[];
  templateSources: TemplateSource[];
  alertRules: AlertRule[];
  autoUpdate: AutoUpdateConfig | null;
  preferences: Settings | null;
}

export type SectionId = 'registries' | 'customTemplates' | 'templateSources' | 'alertRules' | 'autoUpdate' | 'preferences';
export const SECTIONS: SectionId[] = ['registries', 'customTemplates', 'templateSources', 'alertRules', 'autoUpdate', 'preferences'];

export interface Current {
  registries: Registry[];
  customTemplates: BackupTemplate[];
  templateSources: TemplateSource[];
  alertRules: AlertRule[];
  autoUpdate: AutoUpdateConfig;
  preferences: Settings;
}

export function buildBackup(cur: Current, opts: { passwords: boolean; now?: Date }): Backup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    includesPasswords: opts.passwords,
    registries: cur.registries.map((r) => ({ id: r.id, server: r.server, username: r.username, password: opts.passwords ? r.password : '' })),
    customTemplates: cur.customTemplates,
    templateSources: cur.templateSources,
    alertRules: cur.alertRules,
    autoUpdate: cur.autoUpdate,
    preferences: cur.preferences,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);

export class BackupError extends Error {
  key: string;
  vars?: Record<string, string | number>;
  constructor(key: string, vars?: Record<string, string | number>) {
    super(key);
    this.key = key;
    this.vars = vars;
  }
}

/** Reads and checks a backup. Throws BackupError (an i18n key `backup.err.*`) when it is not one this plugin can use. */
export function parseBackup(text: string): Backup {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new BackupError('backup.err.json');
  }
  if (!isObj(doc) || doc.format !== BACKUP_FORMAT) throw new BackupError('backup.err.format');
  const version = typeof doc.version === 'number' ? doc.version : 0;
  if (version < 1) throw new BackupError('backup.err.format');
  if (version > BACKUP_VERSION) throw new BackupError('backup.err.newer', { version, supported: BACKUP_VERSION });
  const registries: Registry[] = list(doc.registries)
    .filter((r) => str(r.server))
    .map((r) => ({ id: str(r.id) || Math.random().toString(36).slice(2, 10), server: str(r.server), username: str(r.username), password: str(r.password) }));
  const customTemplates: BackupTemplate[] = list(doc.customTemplates)
    .filter((t) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(str(t.file)) && t.doc !== undefined)
    .map((t) => ({ file: str(t.file), doc: t.doc }));
  const templateSources: TemplateSource[] = list(doc.templateSources)
    .filter((s) => /^https:\/\//.test(str(s.url)))
    .map((s) => ({ id: str(s.id) || 'source', name: str(s.name) || str(s.url), url: str(s.url), enabled: s.enabled !== false }));
  const alertRules = list(doc.alertRules).filter((r) => str(r.id) && str(r.kind)) as unknown as AlertRule[];
  return {
    format: BACKUP_FORMAT,
    version,
    exportedAt: str(doc.exportedAt),
    includesPasswords: doc.includesPasswords === true,
    registries,
    customTemplates,
    templateSources,
    alertRules,
    autoUpdate: isObj(doc.autoUpdate) && isObj(doc.autoUpdate.schedule) ? (doc.autoUpdate as unknown as AutoUpdateConfig) : null,
    preferences: isObj(doc.preferences) ? (doc.preferences as unknown as Settings) : null,
  };
}

/* ---------- import plan ---------- */

export interface SectionPlan {
  id: SectionId;
  /** Items in the backup. */
  total: number;
  added: number;
  replaced: number;
  unchanged: number;
}

export interface Merged {
  registries: Registry[];
  customTemplates: BackupTemplate[];
  templateSources: TemplateSource[];
  alertRules: AlertRule[];
  autoUpdate: AutoUpdateConfig;
  preferences: Settings;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Keys that decide whether an item in the backup is "the same" as one here. */
const KEYS = {
  registries: (r: Registry) => `${r.server.toLowerCase()}\n${r.username}`,
  customTemplates: (t: BackupTemplate) => t.file,
  templateSources: (s: TemplateSource) => s.url,
  alertRules: (r: AlertRule) => r.id,
};

function mergeList<T>(cur: T[], inc: T[], key: (x: T) => string, patch?: (incoming: T, existing: T) => T): { out: T[]; added: number; replaced: number; unchanged: number } {
  const out = cur.slice();
  let added = 0;
  let replaced = 0;
  let unchanged = 0;
  for (const raw of inc) {
    const at = out.findIndex((x) => key(x) === key(raw));
    if (at < 0) {
      out.push(raw);
      added++;
      continue;
    }
    const next = patch ? patch(raw, out[at]) : raw;
    if (same(next, out[at])) unchanged++;
    else {
      out[at] = next;
      replaced++;
    }
  }
  return { out, added, replaced, unchanged };
}

/**
 * What importing would do, and the result. `only` limits it to some sections. A registry that comes without a
 * password keeps the password it has here.
 */
export function planImport(b: Backup, cur: Current, only: SectionId[] = SECTIONS): { plan: SectionPlan[]; merged: Merged } {
  const use = (id: SectionId) => only.includes(id);
  const merged: Merged = { ...cur };
  const plan: SectionPlan[] = [];

  const reg = mergeList(cur.registries, use('registries') ? b.registries : [], KEYS.registries, (inc, ex) => ({ id: ex.id, server: inc.server, username: inc.username, password: inc.password || ex.password }));
  merged.registries = reg.out;
  plan.push({ id: 'registries', total: b.registries.length, added: reg.added, replaced: reg.replaced, unchanged: reg.unchanged });

  const tpl = mergeList(cur.customTemplates, use('customTemplates') ? b.customTemplates : [], KEYS.customTemplates);
  merged.customTemplates = tpl.out;
  plan.push({ id: 'customTemplates', total: b.customTemplates.length, added: tpl.added, replaced: tpl.replaced, unchanged: tpl.unchanged });

  const src = mergeList(cur.templateSources, use('templateSources') ? b.templateSources : [], KEYS.templateSources);
  merged.templateSources = src.out;
  plan.push({ id: 'templateSources', total: b.templateSources.length, added: src.added, replaced: src.replaced, unchanged: src.unchanged });

  const rules = mergeList(cur.alertRules, use('alertRules') ? b.alertRules : [], KEYS.alertRules);
  merged.alertRules = rules.out;
  plan.push({ id: 'alertRules', total: b.alertRules.length, added: rules.added, replaced: rules.replaced, unchanged: rules.unchanged });

  const one = (id: SectionId, inc: unknown, ex: unknown) => {
    const total = inc ? 1 : 0;
    const diff = use(id) && !!inc && !same(inc, ex);
    plan.push({ id, total, added: 0, replaced: diff ? 1 : 0, unchanged: use(id) && inc && !diff ? 1 : 0 });
    return diff;
  };
  if (one('autoUpdate', b.autoUpdate, cur.autoUpdate)) merged.autoUpdate = b.autoUpdate!;
  if (one('preferences', b.preferences, cur.preferences)) merged.preferences = { ...cur.preferences, ...b.preferences! };
  return { plan, merged };
}

export const hasChanges = (plan: SectionPlan[]): boolean => plan.some((p) => p.added + p.replaced > 0);
