/**
 * What the plugin remembers about a stack that was cloned from Git: `/opt/stacks/<name>/.ervisio-git.json`. It holds no
 * secret (tokens and keys live in the user's private plugin folder, see git.ts). Pure code, no SDK.
 */
export const GIT_META_FILE = '.ervisio-git.json';

export interface GitMeta {
  v: 1;
  /** Repository address as typed: https://, http://, ssh:// or git@host:path. */
  url: string;
  /** Branch or tag. */
  ref: string;
  /** Compose file inside the repository, for example `deploy/compose.yaml`. */
  compose: string;
  /** How the repository is reached: no login, an https token, or an ssh deploy key. */
  auth: 'none' | 'token' | 'ssh';
  /** Who added it. The credentials belong to this user: updates run as them. */
  by?: string;
  added: number;
}

export function parseGitMeta(text: string | null): GitMeta | null {
  if (!text) return null;
  try {
    const m = JSON.parse(text) as Partial<GitMeta>;
    if (m && typeof m.url === 'string' && typeof m.ref === 'string' && typeof m.compose === 'string') {
      return { v: 1, url: m.url, ref: m.ref, compose: m.compose, auth: m.auth === 'token' || m.auth === 'ssh' ? m.auth : 'none', by: m.by, added: typeof m.added === 'number' ? m.added : 0 };
    }
  } catch {
    /* not ours */
  }
  return null;
}

export const metaText = (m: GitMeta): string => JSON.stringify(m, null, 2) + '\n';

/** Folder of the compose file: where `.env` and relative paths of the compose file live. */
export function composeDirOf(stackDir: string, gitFile?: string): string {
  if (!gitFile || !gitFile.includes('/')) return stackDir;
  return `${stackDir}/${gitFile.replace(/\/[^/]*$/, '')}`;
}

/* The patterns below are the same as the arguments of the manifest's git commands (a test compares them). */

const HOST = '[A-Za-z0-9][A-Za-z0-9.-]*';
const PATH = '(/[A-Za-z0-9._~%+-]+)+/?';
const USER = '[A-Za-z0-9._-]+@';
export const URL_PATTERN = `https?://${HOST}(:[0-9]+)?${PATH}|ssh://(${USER})?${HOST}(:[0-9]+)?${PATH}|${USER}${HOST}:[A-Za-z0-9._~%+-][A-Za-z0-9._~%+/-]*`;
export const REF_PATTERN = '[A-Za-z0-9][A-Za-z0-9._/-]{0,127}';
const SEG = '[A-Za-z0-9_@+-][A-Za-z0-9_@+.-]*';
export const FILE_PATTERN = `(${SEG}/)*${SEG}\\.ya?ml`;

const whole = (p: string) => new RegExp(`^(?:${p})$`);
export const validUrl = (s: string): boolean => whole(URL_PATTERN).test(s) && s.length <= 512;
export const validRef = (s: string): boolean => whole(REF_PATTERN).test(s) && !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock');
export const validFile = (s: string): boolean => whole(FILE_PATTERN).test(s) && s.length <= 200;

/** "https", "http" or "ssh". */
export function urlKind(url: string): 'https' | 'http' | 'ssh' | null {
  if (/^https:\/\//.test(url)) return 'https';
  if (/^http:\/\//.test(url)) return 'http';
  if (/^ssh:\/\//.test(url) || /^[A-Za-z0-9._-]+@[^/:]+:/.test(url)) return 'ssh';
  return null;
}

/** "https://user:pw@host/x" is refused: tokens belong in the credentials field, not in an address that is shown and logged. */
export const hasSecretInUrl = (url: string): boolean => /^https?:\/\/[^/]*:[^/]*@/.test(url) || /^https?:\/\/[^/@]*@/.test(url);

/** A short label for a repository: "github.com/org/repo". */
export function repoLabel(url: string): string {
  return url.replace(/^[a-z]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):(?!\d+\/)/, '$1/').replace(/\.git\/?$/, '').replace(/\/$/, '');
}

/** One line of a git credential-store file for an https token. Returns null for an address that cannot take one. */
export function credentialLine(url: string, username: string, token: string): string | null {
  const m = /^(https?):\/\/([^/@]+)(\/|$)/.exec(url);
  if (!m) return null;
  const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${m[1]}://${enc(username || 'git')}:${enc(token)}@${m[2]}\n`;
}

export interface RemoteRefs {
  /** Default branch, from `ls-remote --symref`. */
  head?: string;
  branches: string[];
  tags: string[];
}

/** Output of `git ls-remote --symref`. Peeled tags (`^{}`) are folded into their tag. */
export function parseLsRemote(out: string): RemoteRefs {
  const r: RemoteRefs = { branches: [], tags: [] };
  for (const line of out.split('\n')) {
    let m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line);
    if (m) {
      r.head = m[1];
      continue;
    }
    m = /^[0-9a-f]{40,64}\trefs\/heads\/(\S+)$/.exec(line);
    if (m) {
      r.branches.push(m[1]);
      continue;
    }
    m = /^[0-9a-f]{40,64}\trefs\/tags\/(\S+?)(\^\{\})?$/.exec(line);
    if (m && !r.tags.includes(m[1])) r.tags.push(m[1]);
  }
  return r;
}

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

/** Output of `git log -1 --format=%H%x1f%an%x1f%aI%x1f%s`. */
export function parseCommit(out: string): CommitInfo | null {
  const [hash, author, date, ...rest] = out.replace(/\n$/, '').split('\u001f');
  return hash && /^[0-9a-f]{7,64}$/.test(hash) ? { hash, author: author ?? '', date: date ?? '', subject: rest.join('\u001f') } : null;
}

/** Lines of `git status --porcelain` as file names. */
export function parseStatus(out: string): string[] {
  return out.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
}

/** What a failed git call means for a person. */
export function explainGitError(stderr: string): { key: string; detail: string } {
  const e = stderr.trim();
  const last = e.split('\n').filter(Boolean).slice(-2).join(' ');
  if (/could not read (Username|Password)|Authentication failed|HTTP 40[13]|returned error: 40[13]|terminal prompts disabled/i.test(e)) return { key: 'git.err.auth', detail: last };
  if (/Permission denied \(publickey|Host key verification failed|no such identity|Load key/i.test(e)) return { key: 'git.err.ssh', detail: last };
  if (/not found|does not exist|Repository not found|returned error: 404/i.test(e)) return { key: 'git.err.notFound', detail: last };
  if (/Could not resolve host|Connection refused|timed out|Network is unreachable|Failed to connect/i.test(e)) return { key: 'git.err.network', detail: last };
  if (/Remote branch .* not found|couldn't find remote ref/i.test(e)) return { key: 'git.err.ref', detail: last };
  if (/already exists and is not an empty directory/i.test(e)) return { key: 'git.err.exists', detail: last };
  if (/Permission denied/i.test(e)) return { key: 'git.err.perm', detail: last };
  return { key: 'git.err.other', detail: last || e };
}

/** Intervals offered for automatic updates, in seconds. */
export const UPDATE_INTERVALS = [300, 900, 1800, 3600, 21600, 86400];
