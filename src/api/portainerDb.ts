/**
 * Reads what the plugin can use out of Portainer's database (portainer.db, a BoltDB file, see bolt.ts): stacks (also
 * Git ones), registries, custom templates and environments. Pure code, no SDK.
 *
 * Portainer changed how a Git stack is stored. Older versions keep it in the stack (`GitConfig`); version 2.4x keeps the
 * repository in the `sources` bucket and the file and branch in `workflows`, and the stack only names its `WorkflowID`.
 * Both are read. A database that is encrypted (Portainer started with a secret) is stored in `portainer.edb` and its values
 * are not JSON: that throws PortainerDbError('encrypted') and nothing is read.
 */
import { BoltDB, BoltError, bytesToText, type Bucket } from './bolt.ts';

export class PortainerDbError extends Error {
  code: 'encrypted' | 'unreadable' | 'empty';
  constructor(code: PortainerDbError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface PGit {
  url: string;
  /** Branch or tag name, without refs/heads/ or refs/tags/. */
  ref: string;
  /** Compose file in the repository. */
  file: string;
  username?: string;
  password?: string;
  tlsSkipVerify: boolean;
}

export interface PStack {
  id: number;
  name: string;
  kind: 'compose' | 'swarm' | 'kubernetes';
  endpointId: number;
  entryPoint: string;
  /** Folder in Portainer's data volume, for example /data/compose/3. */
  projectPath: string;
  env: { key: string; value: string }[];
  git?: PGit;
  /** Automatic update interval of a Git stack, in seconds. */
  autoUpdateSeconds?: number;
  /** The stack has a Portainer webhook (its address cannot be reused). */
  hadWebhook: boolean;
  active: boolean;
  created: number;
  createdBy: string;
}

export interface PRegistry {
  id: number;
  name: string;
  /** Portainer's registry kind: custom, Docker Hub, GitLab, ... */
  kind: string;
  server: string;
  username: string;
  password: string;
  authentication: boolean;
  /** Why it cannot be imported as a login (ECR, Azure with a token, no address), when it cannot. */
  unsupported?: string;
}

export interface PTemplate {
  id: number;
  title: string;
  description: string;
  note: string;
  logo: string;
  kind: 'compose' | 'swarm' | 'kubernetes';
  windows: boolean;
  variables: { name: string; label: string; default: string; description: string }[];
  entryPoint: string;
  projectPath: string;
  git?: { url: string; ref: string; file: string };
}

export type EnvMapping = 'this-machine' | 'tcp-tls' | 'portainer-agent' | 'none';

export interface PEndpoint {
  id: number;
  name: string;
  kind: 'docker' | 'agent' | 'edge-agent' | 'azure' | 'kubernetes' | 'other';
  url: string;
  publicUrl: string;
  tls: boolean;
  groupId: number;
  up?: boolean;
  /** What it could become in Settings › Environments. */
  maps: EnvMapping;
  /** Address to put in the Ervisio environment, when there is one. */
  address?: string;
  note?: string;
}

export interface PortainerData {
  version: string;
  stacks: PStack[];
  registries: PRegistry[];
  templates: PTemplate[];
  endpoints: PEndpoint[];
}

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const bigEndian = (k: Uint8Array): number => {
  let n = 0;
  for (const b of k) n = n * 256 + b;
  return n;
};

/** The JSON objects of a bucket, by integer id. A value that is not JSON means the database is encrypted. */
function records(b: Bucket | null): { id: number; v: J }[] {
  if (!b) return [];
  const out: { id: number; v: J }[] = [];
  for (const [k, val] of b.pairs()) {
    let v: J;
    try {
      v = JSON.parse(bytesToText(val));
    } catch {
      throw new PortainerDbError('encrypted', 'The values in this database are not readable text: it is encrypted.');
    }
    if (v && typeof v === 'object') out.push({ id: k.length === 8 ? bigEndian(k) : Number(v.Id ?? v.id ?? 0), v });
  }
  return out.sort((a, b) => a.id - b.id);
}

const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const num = (x: unknown): number => (typeof x === 'number' ? x : 0);

const REGISTRY_KINDS: Record<number, string> = { 1: 'Quay.io', 2: 'Azure', 3: 'Custom', 4: 'GitLab', 5: 'ProGet', 6: 'Docker Hub', 7: 'AWS ECR', 8: 'GitHub' };
const STACK_KINDS: Record<number, PStack['kind']> = { 1: 'swarm', 2: 'compose', 3: 'kubernetes' };

/** "refs/heads/main" gives "main"; "refs/tags/v1" gives "v1". */
export const refName = (r: string): string => r.replace(/^refs\/(heads|tags)\//, '');

/** Portainer intervals such as "5m", "1h30m", "24h" in seconds, or undefined. */
export function intervalSeconds(s: string): number | undefined {
  const m = /^\s*((?:\d+(?:\.\d+)?[hms])+)\s*$/.exec(s ?? '');
  if (!m) return undefined;
  let total = 0;
  for (const p of m[1].matchAll(/(\d+(?:\.\d+)?)([hms])/g)) total += Number(p[1]) * (p[2] === 'h' ? 3600 : p[2] === 'm' ? 60 : 1);
  return total > 0 ? Math.round(total) : undefined;
}

/** `{{ NAME }}` (Portainer custom templates) to `${NAME}` (compose). */
export const mustacheToCompose = (text: string): string => text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, '${$1}');

function endpointOf(v: J, id: number): PEndpoint {
  const type = num(v.Type);
  const url = str(v.URL);
  const tls = !!(v.TLSConfig?.TLS || v.TLS);
  const base = { id, name: str(v.Name), url, publicUrl: str(v.PublicURL), tls, groupId: num(v.GroupId), up: v.Status === undefined ? undefined : v.Status === 1 };
  const host = url.replace(/^tcp:\/\//, '');
  switch (type) {
    case 1:
      if (url.startsWith('unix://') || url.startsWith('npipe://')) return { ...base, kind: 'docker', maps: 'this-machine', note: 'The Docker engine of the machine Portainer runs on: this one, if Portainer runs here.' };
      return { ...base, kind: 'docker', maps: 'tcp-tls', address: host, note: tls ? 'Docker API over TCP with TLS: needs the CA and client certificate.' : 'Docker API over TCP without TLS. Use TLS when you add it.' };
    case 2:
      return { ...base, kind: 'agent', maps: 'portainer-agent', address: host, note: 'Portainer Agent: add it as a Portainer Agent environment (the agent secret is not in the database).' };
    case 4:
    case 7:
      return { ...base, kind: 'edge-agent', maps: 'none', note: 'Edge agents connect out to Portainer. There is no address to add; install an Ervisio-reachable access (SSH or TLS) on that host.' };
    case 3:
      return { ...base, kind: 'azure', maps: 'none', note: 'Azure ACI is not supported.' };
    case 5:
    case 6:
      return { ...base, kind: 'kubernetes', maps: 'none', note: 'Kubernetes is not supported.' };
    default:
      return { ...base, kind: 'other', maps: 'none' };
  }
}

/** Parses the bytes of portainer.db. Throws PortainerDbError. */
export function readPortainerDb(bytes: Uint8Array): PortainerData {
  let db: BoltDB;
  try {
    db = new BoltDB(bytes);
  } catch (e) {
    throw new PortainerDbError('unreadable', e instanceof BoltError ? e.message : (e as Error).message);
  }
  try {
    const root = db.root;
    const names = new Set(root.bucketNames());
    if (!names.has('stacks') && !names.has('endpoints') && !names.has('version')) throw new PortainerDbError('unreadable', 'This is a BoltDB file, but not a Portainer database.');
    const bucket = (n: string) => root.bucket(n);

    const versionRec = records(bucket('version'));
    const version = str(versionRec.find((r) => r.v.SchemaVersion)?.v.SchemaVersion) || str(versionRec.find((r) => r.v.VERSION)?.v.VERSION);

    const sources = new Map(records(bucket('sources')).map((r) => [r.id, r.v]));
    const workflows = new Map(records(bucket('workflows')).map((r) => [r.id, r.v]));
    const credentials = new Map(records(bucket('git_credentials')).map((r) => [r.id, r.v]));

    const stacks: PStack[] = records(bucket('stacks')).map(({ id, v }) => {
      const env = (Array.isArray(v.Env) ? (v.Env as J[]) : []).filter((e) => e?.name).map((e) => ({ key: str(e.name), value: str(e.value) }));
      let git: PGit | undefined;
      const gc = v.GitConfig as J | null;
      if (gc && gc.URL) {
        const auth = (gc.Authentication ?? {}) as J;
        const cred = num(auth.GitCredentialID) ? credentials.get(num(auth.GitCredentialID)) : undefined;
        git = {
          url: str(gc.URL),
          ref: refName(str(gc.ReferenceName)) || 'main',
          file: str(gc.ConfigFilePath) || str(v.EntryPoint),
          username: str(cred?.username ?? auth.Username) || undefined,
          password: str(cred?.password ?? auth.Password) || undefined,
          tlsSkipVerify: !!gc.TLSSkipVerify,
        };
      } else if (num(v.WorkflowID)) {
        const wf = workflows.get(num(v.WorkflowID));
        const art = (Array.isArray(wf?.artifacts) ? (wf!.artifacts as J[]) : []).find((a) => num(a.stackId) === id);
        const file = (Array.isArray(art?.files) ? (art!.files as J[]) : [])[0];
        const src = file ? sources.get(num(file.sourceId)) : undefined;
        if (file && src?.git?.URL) {
          const auth = (src.git.Authentication ?? {}) as J;
          git = {
            url: str(src.git.URL),
            ref: refName(str(file.ref)) || 'main',
            file: str(file.path) || str(v.EntryPoint),
            username: str(auth.Username) || undefined,
            password: str(auth.Password) || undefined,
            tlsSkipVerify: !!src.git.TLSSkipVerify,
          };
        }
      }
      const au = v.AutoUpdate as J | null;
      return {
        id,
        name: str(v.Name),
        kind: STACK_KINDS[num(v.Type)] ?? 'compose',
        endpointId: num(v.EndpointId),
        entryPoint: str(v.EntryPoint),
        projectPath: str(v.ProjectPath),
        env,
        git,
        autoUpdateSeconds: au ? intervalSeconds(str(au.Interval)) : undefined,
        hadWebhook: !!au?.Webhook,
        active: num(v.Status) !== 2,
        created: num(v.CreationDate),
        createdBy: str(v.CreatedBy),
      };
    });

    const registries: PRegistry[] = records(bucket('registries')).map(({ id, v }) => {
      const type = num(v.Type);
      let server = str(v.URL);
      if (type === 6 && !server) server = 'docker.io';
      if (type === 1 && !server) server = 'quay.io';
      const r: PRegistry = { id, name: str(v.Name), kind: REGISTRY_KINDS[type] ?? `Type ${type}`, server, username: str(v.Username), password: str(v.Password), authentication: !!v.Authentication };
      if (type === 7) r.unsupported = 'AWS ECR logins are temporary tokens: they cannot be stored.';
      else if (!server) r.unsupported = 'The registry has no address.';
      return r;
    });

    const templates: PTemplate[] = records(bucket('customtemplates')).map(({ id, v }) => {
      const gc = v.GitConfig as J | null;
      return {
        id,
        title: str(v.Title),
        description: str(v.Description),
        note: str(v.Note),
        logo: str(v.Logo),
        kind: STACK_KINDS[num(v.Type)] ?? 'compose',
        windows: num(v.Platform) === 2,
        variables: (Array.isArray(v.Variables) ? (v.Variables as J[]) : []).filter((x) => x?.name).map((x) => ({ name: str(x.name), label: str(x.label) || str(x.name), default: str(x.defaultValue), description: str(x.description) })),
        entryPoint: str(v.EntryPoint),
        projectPath: str(v.ProjectPath),
        git: gc?.URL ? { url: str(gc.URL), ref: refName(str(gc.ReferenceName)), file: str(gc.ConfigFilePath) } : undefined,
      };
    });

    const endpoints = records(bucket('endpoints')).map(({ id, v }) => endpointOf(v, id));
    return { version, stacks, registries, templates, endpoints };
  } catch (e) {
    if (e instanceof PortainerDbError) throw e;
    if (e instanceof BoltError) throw new PortainerDbError('unreadable', e.message);
    throw e;
  }
}

/** Where Portainer keeps its data inside its container. */
export const PORTAINER_DB = '/data/portainer.db';
export const PORTAINER_ENCRYPTED_DB = '/data/portainer.edb';
