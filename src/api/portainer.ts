/**
 * Import from Portainer. Portainer keeps everything in /data of its own container: portainer.db (BoltDB, read by
 * portainerDb.ts), the stacks' files in /data/compose/<id> and the custom templates in /data/custom_templates/<id>.
 * They are read through GET /containers/{id}/archive, so no Portainer login is needed. The container may be stopped.
 * Nothing in Portainer is changed; stacks and templates are copied into Ervisio.
 */
import { envFromPairs } from './dotenv';
import { docker, DockerError } from './engine';
import { fsx, isValidStackName, moveFromOrigin, planMove, stackDir, type MovePlan, type OriginFiles } from './compose';
import { cloneStack, GitError, type GitAuth } from './git';
import { t } from '../i18n';
import { composeDirOf, validFile, validRef, validUrl, urlKind } from './gitMeta';
import { jobsApi, jobsAvailable, pollJob } from './jobs';
import { isPortainerImage, parseTar, rewriteBinds, type ContainerLike } from './origin';
import { PORTAINER_DB, PORTAINER_ENCRYPTED_DB, PortainerDbError, mustacheToCompose, readPortainerDb, type PRegistry, type PStack, type PTemplate, type PortainerData } from './portainerDb';
import { listRegistries, normalizeServer } from './registries';
import { setFile } from '../settings';
import { saveCustomTemplate, customTemplates } from './customTemplates';
import { hueFor, type Template } from './templateModel';
import type { Container } from './types';

export { PortainerDbError } from './portainerDb';

export interface PortainerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
}

/** Portainer server containers (not agents), running or stopped. */
export async function findPortainer(): Promise<PortainerContainer[]> {
  const list = await docker.get<Container[]>('/containers/json', { all: '1' });
  return list
    .filter((c) => isPortainerImage(c.Image) || c.Labels?.['io.portainer.server'] === 'true')
    .map((c) => ({ id: c.Id, name: c.Names?.[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12), image: c.Image, state: c.State }));
}

const MAX_FILE = 256 * 1024 * 1024;

/** One file of a container as bytes, or null when it is not there. Streams, so a database over 8 MB is fine. */
export function readContainerBytes(id: string, path: string, max = MAX_FILE): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const parts: Uint8Array[] = [];
    let size = 0;
    let missing = false;
    let tooBig = false;
    const h = docker.stream('GET', `/containers/${id}/archive`, { query: { path } }, {
      onStart: () => undefined,
      onData: (c) => {
        size += c.length;
        if (size > max) {
          tooBig = true;
          h.close();
          reject(new Error(`${path} is larger than ${Math.round(max / 1048576)} MB.`));
          return;
        }
        parts.push(c);
      },
      onEnd: () => {
        if (tooBig) return;
        if (missing) return resolve(null);
        const all = new Uint8Array(size);
        let o = 0;
        for (const p of parts) {
          all.set(p, o);
          o += p.length;
        }
        try {
          const files = parseTar(all, max, 8);
          resolve(files.length ? files[0].data : null);
        } catch (e) {
          reject(e);
        }
      },
      onError: (e) => {
        if (e instanceof DockerError && e.status === 404) return resolve(null);
        if (/could not find the file|no such file|not exist|404/i.test(e.message)) {
          missing = true;
          return resolve(null);
        }
        reject(e);
      },
    });
  });
}

/** Whether a path exists in the container, without downloading it. */
export function containerHas(id: string, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      h.close();
      resolve(v);
    };
    const h = docker.stream('GET', `/containers/${id}/archive`, { query: { path } }, { onStart: () => finish(true), onData: () => undefined, onEnd: () => finish(false), onError: () => finish(false) });
  });
}

export async function readText(id: string, path: string): Promise<string | null> {
  const b = await readContainerBytes(id, path, 4 * 1024 * 1024);
  return b ? new TextDecoder().decode(b) : null;
}

/** Reads and parses portainer.db of a container. Throws PortainerDbError ('encrypted', 'unreadable', 'empty'). */
export async function loadPortainerData(c: PortainerContainer): Promise<PortainerData> {
  const bytes = await readContainerBytes(c.id, PORTAINER_DB);
  if (!bytes) {
    if (await containerHas(c.id, PORTAINER_ENCRYPTED_DB)) throw new PortainerDbError('encrypted', 'Portainer encrypted its database (portainer.edb).');
    throw new PortainerDbError('empty', 'There is no /data/portainer.db in this container. Is /data a volume that Portainer has used?');
  }
  return readPortainerDb(bytes);
}

/* ---------- stacks ---------- */

export type StackVerdict = { ok: true } | { ok: false; reason: string };

/** Whether a stack can be imported, and why not. `local` says its environment is this machine's engine. */
export function stackVerdict(s: PStack, taken: Set<string>, local: Set<number>): StackVerdict {
  if (s.kind !== 'compose') return { ok: false, reason: s.kind === 'swarm' ? 'swarm' : 'kubernetes' };
  if (!local.has(s.endpointId)) return { ok: false, reason: 'remote' };
  if (!isValidStackName(s.name)) return { ok: false, reason: 'name' };
  if (taken.has(s.name)) return { ok: false, reason: 'exists' };
  if (s.git && (!validUrl(s.git.url) || !validRef(s.git.ref) || !validFile(s.git.file))) return { ok: false, reason: 'gitbad' };
  return { ok: true };
}

const asLike = (c: Container): ContainerLike => ({ Id: c.Id, Names: c.Names, Image: c.Image, Labels: c.Labels, Mounts: c.Mounts });

export interface StackPlan {
  stack: PStack;
  /** A plain stack: what moving it writes. */
  move?: MovePlan;
  origin?: OriginFiles;
  problem?: string;
}

/** Reads a plain stack's files out of Portainer and plans the move (relative binds become absolute host paths). */
export async function planStack(c: PortainerContainer, s: PStack, all: Container[]): Promise<StackPlan> {
  const dir = s.projectPath || `/data/compose/${s.id}`;
  const composeFile = `${dir}/${s.entryPoint || 'docker-compose.yml'}`;
  const compose = await readText(c.id, composeFile);
  if (compose === null) return { stack: s, problem: `Portainer has no ${composeFile}.` };
  const env: OriginFiles['env'] = s.env.length ? [{ path: `${dir}/stack.env`, text: envFromPairs(s.env) }] : [];
  const mine = all.filter((x) => x.Labels?.['com.docker.compose.project'] === s.name).map(asLike);
  const origin: OriginFiles = {
    origin: { kind: 'portainer', container: c.name, containerId: c.id, stackId: s.id, dir },
    composeFile,
    compose,
    env,
    extra: [],
  };
  try {
    // Relative env_file entries sit next to the compose file: copy those too.
    for (const rel of rewriteBinds(compose, dir, mine).envFiles) {
      const text = await readText(c.id, `${dir}/${rel}`).catch(() => null);
      if (text !== null) origin.extra.push({ path: rel, text });
    }
    return { stack: s, origin, move: planMove(s.name, origin, mine as unknown as Container[]) };
  } catch (e) {
    return { stack: s, problem: (e as Error).message };
  }
}

export interface StackResult {
  name: string;
  status: 'done' | 'skipped' | 'failed';
  note?: string;
}

/** Imports one stack. `withLogin` says whether a Git login saved in Portainer may be copied. Never deploys. */
export async function importStack(c: PortainerContainer, s: PStack, all: Container[], opts: { withLogin: boolean }, onLine: (l: string) => void): Promise<StackResult> {
  try {
    if (s.git) {
      const g = s.git;
      const kind = urlKind(g.url);
      const hasLogin = !!g.password;
      const auth: GitAuth = opts.withLogin && hasLogin ? (kind === 'ssh' ? { kind: 'none' } : { kind: 'token', username: g.username, secret: g.password }) : { kind: 'none' };
      onLine(`${s.name}: cloning ${g.url} (${g.ref})`);
      await cloneStack(s.name, { url: g.url, ref: g.ref, compose: g.file, auth: auth.kind }, auth, (_s, line) => onLine(line));
      if (s.env.length) await fsx.write(`${composeDirOf(stackDir(s.name), g.file)}/.env`, envFromPairs(s.env));
      let note = hasLogin && !opts.withLogin ? 'The repository needs a login that was not imported: add it in the stack\'s Git card.' : '';
      if (s.autoUpdateSeconds && jobsAvailable()) {
        try {
          const every = Math.max(60, s.autoUpdateSeconds);
          await jobsApi().create({ job: pollJob('f'), name: `Update ${s.name}`, params: { name: s.name, ref: g.ref, file: g.file }, schedule: { every } });
          note += ` Automatic updates every ${Math.round(every / 60)} minutes were set up.`;
        } catch (e) {
          note += ` Automatic updates were not set up: ${(e as Error).message}.`;
        }
      }
      return { name: s.name, status: 'done', note: note.trim() || undefined };
    }
    const plan = await planStack(c, s, all);
    if (!plan.move) return { name: s.name, status: 'failed', note: plan.problem };
    onLine(`${s.name}: writing ${plan.move.files.join(', ')}`);
    await moveFromOrigin(s.name, plan.move);
    const paths = plan.move.changes.filter((x) => x.source === 'path').length;
    return { name: s.name, status: 'done', note: paths ? `${paths} relative path(s) point into Portainer's data volume: check them before deploying.` : undefined };
  } catch (e) {
    if (e instanceof GitError) {
      const skipped = !!s.git?.password && !opts.withLogin;
      return { name: s.name, status: 'failed', note: skipped && e.key === 'git.err.auth' ? t('pt.git.needsLogin') : t(e.key) + (e.detail && e.key === 'git.err.other' ? ` (${e.detail})` : '') };
    }
    return { name: s.name, status: 'failed', note: (e as Error).message };
  }
}

/* ---------- registries ---------- */

export type RegistryResult = StackResult;

/** Saves registries as plugin logins. `withPassword` per id says whether the stored password is copied. */
export async function importRegistries(list: PRegistry[], withPassword: Set<number>): Promise<RegistryResult[]> {
  const existing = await listRegistries();
  const out: RegistryResult[] = [];
  const next = [...existing];
  for (const r of list) {
    if (r.unsupported) {
      out.push({ name: r.name, status: 'skipped', note: r.unsupported });
      continue;
    }
    const server = normalizeServer(r.server);
    const dup = next.find((x) => normalizeServer(x.server) === server && x.username === r.username);
    if (dup) {
      out.push({ name: r.name, status: 'skipped', note: 'Already saved.' });
      continue;
    }
    const pw = withPassword.has(r.id) ? r.password : '';
    next.push({ id: `p${r.id}-${Math.random().toString(36).slice(2, 7)}`, server: r.server, username: r.username, password: pw });
    out.push({ name: r.name, status: 'done', note: r.authentication && r.username && !pw ? 'The password was not imported: add it in Registries.' : undefined });
  }
  await setFile('registries', { registries: next });
  return out;
}

/* ---------- templates ---------- */

export const templateVerdict = (t: PTemplate): StackVerdict =>
  t.windows ? { ok: false, reason: 'windows' } : t.kind !== 'compose' ? { ok: false, reason: t.kind } : t.git ? { ok: false, reason: 'git' } : { ok: true };

export async function importTemplate(c: PortainerContainer, t: PTemplate): Promise<StackResult> {
  try {
    const dir = t.projectPath || `/data/custom_templates/${t.id}`;
    const text = await readText(c.id, `${dir}/${t.entryPoint || 'docker-compose.yml'}`);
    if (text === null) return { name: t.title, status: 'failed', note: `Portainer has no ${dir}/${t.entryPoint}.` };
    const compose = mustacheToCompose(text);
    const tpl: Template = {
      id: '',
      source: 'custom',
      sourceName: 'Custom',
      name: t.title,
      description: t.description,
      category: 'Other',
      hue: hueFor(t.title),
      type: 'stack',
      featured: false,
      note: t.note || undefined,
      logo: t.logo || undefined,
      variables: t.variables.map((v) => ({ name: v.name, label: v.label, default: v.default, type: 'text' as const, hint: v.description || undefined })),
      compose,
      fixedEnv: [],
    };
    if (customTemplates().some((x) => x.name === t.title)) return { name: t.title, status: 'skipped', note: 'A custom template with this title exists.' };
    await saveCustomTemplate(tpl);
    return { name: t.title, status: 'done' };
  } catch (e) {
    return { name: t.title, status: 'failed', note: (e as Error).message };
  }
}

/* ---------- environments checklist ---------- */

/** Plain text checklist for Settings › Environments. */
export function environmentChecklist(d: PortainerData): string {
  const lines = ['Environments to add in Settings › Environments', ''];
  for (const e of d.endpoints) {
    if (e.maps === 'this-machine') continue;
    const what = e.maps === 'tcp-tls' ? 'Docker over TCP + TLS' : e.maps === 'portainer-agent' ? 'Portainer Agent' : 'cannot be added';
    lines.push(`[ ] ${e.name}: ${what}${e.address ? `, ${e.address}` : ''}${e.publicUrl ? ` (public address ${e.publicUrl})` : ''}`);
  }
  if (lines.length === 2) lines.push('Nothing: every environment in this Portainer is this machine.');
  return lines.join('\n') + '\n';
}
