/**
 * Git stacks: a stack folder that is a clone of a repository. Everything runs through declared `git-*` commands, so the
 * same steps work from a page and from a background job (see scripts/gen-manifest.mjs).
 *
 * Secrets: an https token goes into a git credential-store file and a deploy key into a key file, both in the user's
 * private plugin folder (~/.config/ervisio/plugins/docker/git, mode 600, folder 700). They never travel as arguments, in
 * job parameters, in the stack folder or in the activity log. Updates run as the user who added the stack.
 */
import { CONFIG_DIR } from '../settings';
import { getSdk } from '../sdk';
import { COMPOSE_FILE, DEPLOYED_FILE, ensureStacksFolder, fsx, runCompose, stackDir, type LineHandler } from './compose';
import { GIT_META_FILE, credentialLine, explainGitError, metaText, parseCommit, parseGitMeta, parseLsRemote, parseStatus, type CommitInfo, type GitMeta, type RemoteRefs } from './gitMeta';

export { GIT_META_FILE, type GitMeta, type CommitInfo, type RemoteRefs } from './gitMeta';

const CRED_DIR = `${CONFIG_DIR}/git`;
export const credPath = (name: string) => `${CRED_DIR}/${name}.cred`;
export const keyPath = (name: string) => `${CRED_DIR}/${name}.key`;

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
}

async function git(command: string, args: string[]): Promise<string> {
  const r = await getSdk().api.exec(command, args);
  if (r.exitCode !== 0) throw new GitError(r.stderr || r.stdout);
  return r.stdout;
}

export interface GitAuth {
  kind: 'none' | 'token' | 'ssh';
  username?: string;
  /** Token or private key text. Written once to the private folder. */
  secret?: string;
}

/** Writes (or removes) the credential files of a stack name. */
export async function storeCredentials(name: string, url: string, auth: GitAuth): Promise<void> {
  await removeCredentials(name);
  if (auth.kind === 'none' || !auth.secret) return;
  await fsx.mkdir(CRED_DIR).catch(() => undefined);
  if (auth.kind === 'token') {
    const line = credentialLine(url, auth.username ?? '', auth.secret.trim());
    if (!line) throw new Error('A token needs an http:// or https:// address.');
    await fsx.write(credPath(name), line);
  } else {
    await fsx.write(keyPath(name), auth.secret.replace(/\r\n/g, '\n').replace(/\n*$/, '\n'));
  }
}

export async function removeCredentials(name: string): Promise<void> {
  for (const p of [credPath(name), keyPath(name)]) await fsx.remove(p).catch(() => undefined);
}

/** Lists branches and tags (and proves the address and the login work). */
export async function lsRemote(name: string, url: string): Promise<RemoteRefs> {
  return parseLsRemote(await git('git-ls-remote', [name, url]));
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
    await git('git-clone', [name, meta.url, meta.ref]);
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
  await git('git-fetch', [name, meta.ref]);
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
