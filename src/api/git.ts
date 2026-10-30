/**
 * Git stacks: a stack folder that is a clone of a repository. Everything runs through declared `git-*` commands, so the
 * same steps work from a page and from a background job (see scripts/gen-manifest.mjs).
 *
 * Secrets: an https token goes into a git credential-store file and a deploy key into a key file, both in
 * /opt/stacks/.ervisio-git (folder root:docker 2770, files 600 through the git-auth-lock command). The git commands are
 * admin commands: for a user outside the docker group they run as root, where ~ is root's home, while a plugin write to
 * a ~ folder always lands in the user's own home. /opt/stacks follows the same identity rule as the commands, so the
 * account that writes a login is the one git reads it as. The old ~/.config/ervisio/plugins/docker/git files are still
 * read as a fallback, through a helper that only answers "get", so git never writes a token back into a ~ folder.
 * Secrets never travel as arguments, in job parameters, in the stack folder or in the activity log.
 * The git commands always run on this machine, so these files are never sent to a paired server.
 */
import { CONFIG_DIR } from '../settings';
import { getSdk } from '../sdk';
import { COMPOSE_FILE, DEPLOYED_FILE, STACKS_DIR, ensureStacksFolder, fsx, isNotFound, runCompose, stackDir, type LineHandler } from './compose';
import { GIT_META_FILE, credentialLine, explainGitError, metaText, parseCommit, parseGitMeta, parseLsRemote, parseStatus, type CommitInfo, type GitMeta, type RemoteRefs } from './gitMeta';

export { GIT_META_FILE, type GitMeta, type CommitInfo, type RemoteRefs } from './gitMeta';

/** Folder of the Git logins: the same path as GIT_AUTH_DIR in scripts/gen-manifest.mjs (a test keeps them equal). */
export const GIT_AUTH_DIR = `${STACKS_DIR}/.ervisio-git`;
/** Where logins were kept before: the git commands still read it, the plugin only removes from it. */
export const LEGACY_CRED_DIR = `${CONFIG_DIR}/git`;
export const credPath = (name: string) => `${GIT_AUTH_DIR}/${name}.cred`;
export const keyPath = (name: string) => `${GIT_AUTH_DIR}/${name}.key`;
export const legacyCredPath = (name: string) => `${LEGACY_CRED_DIR}/${name}.cred`;
export const legacyKeyPath = (name: string) => `${LEGACY_CRED_DIR}/${name}.key`;

/** Files on this machine, never with the { env } of a paired server: the git commands that read them run here. */
const localFs = {
  list: (p: string) => getSdk().files.list(p),
  write: (p: string, d: string) => getSdk().files.write(p, d),
  remove: (p: string) => getSdk().files.remove(p),
};

export interface GitTools {
  git: boolean;
  ssh: boolean;
  version: string;
}

export async function gitTools(): Promise<GitTools> {
  const sdk = getSdk();
  const run = (c: string) => sdk.api.exec(c, []).then((r) => r, () => null);
  const [g, s] = await Promise.all([run('git-version'), run('ssh-version')]);
  return { git: !!g && g.exitCode === 0, ssh: !!s && s.exitCode === 0, version: g?.stdout.replace(/^git version\s*/, '').trim() ?? '' };
}

export class GitError extends Error {
  key: string;
  detail: string;
  constructor(stderr: string) {
    const x = explainGitError(stderr);
    super(x.detail || x.key);
    this.key = x.key;
    this.detail = x.detail;
  }

  /** A GitError with a given message key, for causes the plugin finds out itself. */
  static of(key: string, detail: string): GitError {
    const e = new GitError('');
    e.key = key;
    e.detail = detail;
    e.message = detail || key;
    return e;
  }
}

type AuthKind = GitAuth['kind'];

/**
 * True only when the stack should use a token or deploy key and its file is known to be absent from both GIT_AUTH_DIR
 * and the legacy folder. A folder that cannot be listed for another reason (e.g. needs_admin) gives false: the
 * original git error is then shown, not a guess about the saved login.
 */
async function loginFileMissing(name: string, auth: AuthKind): Promise<boolean> {
  if (auth === 'none') return false;
  const want = `${name}.${auth === 'token' ? 'cred' : 'key'}`;
  for (const dir of [GIT_AUTH_DIR, LEGACY_CRED_DIR]) {
    try {
      if ((await localFs.list(dir)).some((e) => e.name === want)) return false;
    } catch (e) {
      if (!isNotFound(e)) return false;
    }
  }
  return true;
}

/**
 * Runs a git-* command (args[0] is always the stack name). With `auth`, a failure that means "no login reached the
 * repository" is reported as git.err.credMissing when the saved login file is not there.
 */
async function git(command: string, args: string[], auth?: AuthKind): Promise<string> {
  const r = await getSdk().api.exec(command, args);
  if (r.exitCode !== 0) {
    const e = new GitError(r.stderr || r.stdout);
    if (auth && (e.key === 'git.err.noLogin' || e.key === 'git.err.ssh') && (await loginFileMissing(args[0], auth))) throw GitError.of('git.err.credMissing', e.detail);
    throw e;
  }
  return r.stdout;
}

export interface GitAuth {
  kind: 'none' | 'token' | 'ssh';
  username?: string;
  /** Token or private key text. Written once to GIT_AUTH_DIR. */
  secret?: string;
}

/** Creates GIT_AUTH_DIR (root:docker 2770) with the admin command git-auth-init when it is missing. */
async function ensureAuthFolder(): Promise<void> {
  try {
    await localFs.list(GIT_AUTH_DIR);
    return;
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  const r = await getSdk().api.exec('git-auth-init', []);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `git-auth-init exited with ${r.exitCode}`);
}

/** Writes (or removes) the credential files of a stack name. The file is made readable by its owner only (600). */
export async function storeCredentials(name: string, url: string, auth: GitAuth): Promise<void> {
  await removeCredentials(name);
  if (auth.kind === 'none' || !auth.secret) return;
  let file: string;
  let text: string;
  if (auth.kind === 'token') {
    const line = credentialLine(url, auth.username ?? '', auth.secret.trim());
    if (!line) throw new Error('A token needs an http:// or https:// address.');
    file = `${name}.cred`;
    text = line;
  } else {
    file = `${name}.key`;
    text = auth.secret.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  }
  await ensureStacksFolder();
  await ensureAuthFolder();
  const path = `${GIT_AUTH_DIR}/${file}`;
  // Write first, then lock: a new file is created 0644 and ssh refuses a key that others can read.
  await localFs.write(path, text);
  let r: { exitCode: number; stderr: string };
  try {
    r = await getSdk().api.exec('git-auth-lock', [file]);
  } catch (e) {
    r = { exitCode: -1, stderr: (e as Error)?.message ?? String(e) };
  }
  if (r.exitCode !== 0) {
    await localFs.remove(path).catch(() => undefined);
    throw new Error(`Could not make ${path} private: ${r.stderr.trim() || `git-auth-lock exited with ${r.exitCode}`}`);
  }
}

export async function removeCredentials(name: string): Promise<void> {
  for (const p of [credPath(name), keyPath(name), legacyCredPath(name), legacyKeyPath(name)]) await localFs.remove(p).catch(() => undefined);
}

/** Lists branches and tags (and proves the address and the login work). */
export async function lsRemote(name: string, url: string, auth?: AuthKind): Promise<RemoteRefs> {
  return parseLsRemote(await git('git-ls-remote', [name, url], auth));
}

export async function readMeta(name: string): Promise<GitMeta | null> {
  try {
    return parseGitMeta(await fsx.read(`${stackDir(name)}/${GIT_META_FILE}`));
  } catch {
    return null;
  }
}

export async function writeMeta(name: string, meta: GitMeta): Promise<void> {
  await fsx.write(`${stackDir(name)}/${GIT_META_FILE}`, metaText(meta));
}

/** Clones into /opt/stacks/<name> and checks the compose file is there. Throws GitError or Error. */
export async function cloneStack(name: string, meta: Omit<GitMeta, 'v' | 'added'>, auth: GitAuth, onLine: LineHandler): Promise<GitMeta> {
  await ensureStacksFolder();
  await storeCredentials(name, meta.url, auth);
  onLine('stdout', `$ git clone --depth 1 --branch ${meta.ref} ${meta.url}`);
  try {
    await git('git-clone', [name, meta.url, meta.ref], meta.auth);
  } catch (e) {
    await removeCredentials(name);
    throw e;
  }
  try {
    await fsx.read(`${stackDir(name)}/${meta.compose}`);
  } catch {
    await removeCredentials(name);
    throw new Error(`The repository has no ${meta.compose}.`);
  }
  const full: GitMeta = { ...meta, v: 1, added: Date.now() };
  await writeMeta(name, full);
  return full;
}

export async function commitOf(name: string): Promise<CommitInfo | null> {
  try {
    return parseCommit(await git('git-info', [name]));
  } catch {
    return null;
  }
}

/** Tracked files that differ from the repository (local edits). */
export async function localEdits(name: string): Promise<string[]> {
  try {
    return parseStatus(await git('git-status', [name]));
  } catch {
    return [];
  }
}

/** Fetches the ref and tells whether it moved. */
export async function checkForUpdate(name: string, meta: GitMeta): Promise<{ head: string; remote: string; behind: boolean }> {
  await git('git-fetch', [name, meta.ref], meta.auth);
  const head = (await git('git-rev-head', [name])).trim();
  const remote = (await git('git-rev-fetched', [name])).trim();
  return { head, remote, behind: head !== remote };
}

/** Fetch, replace the files (local edits are lost), pull images and deploy. Same steps as the git-redeploy job. */
export async function pullAndRedeploy(name: string, meta: GitMeta, onLine: LineHandler): Promise<number> {
  const step = async (cmd: string, args: string[], shown: string): Promise<number> => {
    onLine('stdout', `$ ${shown}`);
    return runCompose(cmd, args, onLine);
  };
  let code = await step('git-fetch', [name, meta.ref], `git fetch origin ${meta.ref}`);
  if (code !== 0) return code;
  code = await step('git-reset', [name], 'git reset --hard FETCH_HEAD');
  if (code !== 0) return code;
  code = await step('compose-pull-git', [name, meta.compose], 'docker compose pull');
  if (code !== 0) return code;
  code = await step('compose-up-git', [name, meta.compose], 'docker compose up -d --remove-orphans --build');
  if (code === 0) {
    try {
      await fsx.write(`${stackDir(name)}/${DEPLOYED_FILE}`, await fsx.read(`${stackDir(name)}/${meta.compose}`));
    } catch {
      /* the Diff tab just has no baseline */
    }
  }
  return code;
}

/**
 * Stop treating the stack as a Git stack: remove .git, the marker and the credentials. The files stay. A compose file
 * that sits in a sub-folder is copied to compose.yaml (and its .env next to it) because plain stacks keep it there.
 */
export async function detachStack(name: string): Promise<{ copied: boolean }> {
  const root = stackDir(name);
  const meta = await readMeta(name);
  let copied = false;
  if (meta && meta.compose !== COMPOSE_FILE) {
    const text = await fsx.read(`${root}/${meta.compose}`);
    // The repository may have its own compose.yaml at the top: keep it as compose.yaml.orig instead of losing it.
    const old = await fsx.read(`${root}/${COMPOSE_FILE}`).catch(() => null);
    if (old !== null && old !== text) await fsx.write(`${root}/${COMPOSE_FILE}.orig`, old);
    await fsx.write(`${root}/${COMPOSE_FILE}`, text);
    const dir = meta.compose.replace(/\/[^/]*$/, '');
    const env = await fsx.read(`${root}/${dir}/.env`).catch(() => null);
    if (env !== null) await fsx.write(`${root}/.env`, env);
    copied = true;
  }
  await removeTree(`${root}/.git`);
  await fsx.remove(`${root}/.git`).catch(() => undefined);
  await fsx.remove(`${root}/${GIT_META_FILE}`).catch(() => undefined);
  await removeCredentials(name);
  return { copied };
}

export async function removeTree(path: string, depth = 0): Promise<void> {
  let entries;
  try {
    entries = await fsx.list(path);
  } catch {
    return;
  }
  for (let i = 0; i < entries.length; i += 8) {
    await Promise.all(
      entries.slice(i, i + 8).map(async (e) => {
        const p = `${path}/${e.name}`;
        if (e.type === 'dir' && depth < 40) await removeTree(p, depth + 1);
        await fsx.remove(p);
      }),
    );
  }
}

export { COMPOSE_FILE };
