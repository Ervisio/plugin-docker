#!/usr/bin/env node
/**
 * Writes the Git, webhook and backup commands and the background jobs into plugin/manifest.json.
 * The manifest stays the file that ships; this script only exists so the long argv lists and the four notification
 * variants of each job are not copied by hand. It replaces the entries it owns (by name) and leaves the rest alone:
 *
 *   node scripts/gen-manifest.mjs          # rewrite plugin/manifest.json
 *   node scripts/gen-manifest.mjs --check  # exit 1 when the file is out of date
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'manifest.json');
const manifest = JSON.parse(readFileSync(file, 'utf8'));

const SOCK = ['docker', '-H', 'unix:///var/run/docker.sock'];
const STACKS = '/opt/stacks';
export const BACKUP_DIR = '/var/backups/ervisio-docker';
/** The helper image of volume backups: the same tag as HELPER_IMAGE in src/api/volumes.ts (a test keeps them equal). */
export const HELPER_IMAGE = 'busybox:1.37';

/* ---------- argument patterns (each matches the whole value) ---------- */

const P_NAME = { pattern: '[a-z0-9][a-z0-9_-]{0,62}', maxLen: 63 };
/** https:// or http:// (a token goes in the credentials file, never in the address), ssh://, or git@host:path. */
const URL_HOST = '[A-Za-z0-9][A-Za-z0-9.-]*';
const URL_PATH = '(/[A-Za-z0-9._~%+-]+)+/?';
const URL_USER = '[A-Za-z0-9._-]+@';
const P_URL = {
  // The whole pattern may not exceed 256 characters.
  pattern: `https?://${URL_HOST}(:[0-9]+)?${URL_PATH}|ssh://(${URL_USER})?${URL_HOST}(:[0-9]+)?${URL_PATH}|${URL_USER}${URL_HOST}:[A-Za-z0-9._~%+-][A-Za-z0-9._~%+/-]*`,
  maxLen: 512,
};
const P_REF = { pattern: '[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', maxLen: 128 };
/** A relative path to a compose file: no leading dot in any part, so no "..". */
const SEG = '[A-Za-z0-9_@+-][A-Za-z0-9_@+.-]*';
const P_FILE = { pattern: `(${SEG}/)*${SEG}\\.ya?ml`, maxLen: 200 };
const P_CONTAINER = { pattern: '[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', maxLen: 128 };
const P_VOLUME = P_CONTAINER;
const P_IMAGE = { pattern: '[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9._-]{1,128})?', maxLen: 256 };
const P_KEEP = { pattern: '[1-9][0-9]{0,2}', maxLen: 3 };

/* ---------- Git ---------- */

const CRED = '~/.config/ervisio/plugins/docker/git/{0}';
/**
 * Every git call carries the same options. Only http(s) and ssh may be used (no file://, git://, ext::). Secrets are read
 * from files in the user's private plugin folder: an https token through git's "store" helper, a deploy key through
 * ssh -i. Nothing secret is ever an argument. git and ssh expand ~ themselves (they start these helpers through a
 * shell), so the same argv works for every user.
 */
const GIT = [
  'git',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.http.allow=always',
  '-c', 'protocol.ssh.allow=always',
  '-c', 'credential.helper=',
  '-c', `credential.helper=store --file ${CRED}.cred`,
  '-c', `core.sshCommand=ssh -i ${CRED}.key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
  '-c', 'core.askPass=',
  '-c', 'http.lowSpeedLimit=1000',
  '-c', 'http.lowSpeedTime=60',
];
const IN_STACK = ['-c', `safe.directory=${STACKS}/{0}`, '-C', `${STACKS}/{0}`];

const priv = { admin: true, adminUnlessGroup: 'docker' };
const cmd = (name, description, argv, args, extra = {}) => ({ ...extra, name, description, argv, args });

const commands = [
  cmd('git-version', 'Check that git is installed', ['git', '--version'], [], { timeoutSec: 10 }),
  cmd('ssh-version', 'Check that ssh is installed (needed for repositories that use a deploy key)', ['ssh', '-V'], [], { timeoutSec: 10 }),
  cmd('git-ls-remote', 'List the branches and tags of a Git repository', [...GIT, 'ls-remote', '--symref', '--', '{1}'], [P_NAME, P_URL], { ...priv, timeoutSec: 60 }),
  cmd('git-clone', 'Clone a Git repository into a new stack folder', [...GIT, 'clone', '--depth', '1', '--single-branch', '--branch', '{2}', '--', '{1}', `${STACKS}/{0}`], [P_NAME, P_URL, P_REF], { ...priv, timeoutSec: 300 }),
  cmd('git-fetch', 'Fetch a branch or tag of the stack repository', [...GIT, ...IN_STACK, 'fetch', '--depth', '1', '--force', 'origin', '{1}'], [P_NAME, P_REF], { ...priv, timeoutSec: 300 }),
  cmd('git-rev-head', 'Commit the stack repository is at', [...GIT, ...IN_STACK, 'rev-parse', 'HEAD'], [P_NAME], { ...priv, timeoutSec: 30 }),
  cmd('git-rev-fetched', 'Commit of the last fetch', [...GIT, ...IN_STACK, 'rev-list', '-n', '1', 'FETCH_HEAD'], [P_NAME], { ...priv, timeoutSec: 30 }),
  cmd('git-reset', 'Move the stack repository to the commit of the last fetch (replaces local edits)', [...GIT, ...IN_STACK, 'reset', '--hard', 'FETCH_HEAD'], [P_NAME], { ...priv, timeoutSec: 60 }),
  cmd('git-info', 'Describe the commit the stack repository is at', [...GIT, ...IN_STACK, 'log', '-1', '--format=%H%x1f%an%x1f%aI%x1f%s'], [P_NAME], { ...priv, timeoutSec: 30 }),
  cmd('git-status', 'List local edits of tracked files in the stack repository', [...GIT, ...IN_STACK, 'status', '--porcelain', '--untracked-files=no'], [P_NAME], { ...priv, timeoutSec: 30 }),
];

/* ---------- compose for a stack whose compose file is not /opt/stacks/<name>/compose.yaml ---------- */

const composeGit = (name, description, tail, timeoutSec) =>
  cmd(name, description, [...SOCK, 'compose', '--project-name', '{0}', '-f', `${STACKS}/{0}/{1}`, ...tail], [P_NAME, P_FILE], { ...priv, timeoutSec });
commands.push(
  composeGit('compose-up-git', 'Create or update the containers of a Git stack', ['up', '-d', '--remove-orphans', '--build'], 600),
  composeGit('compose-pull-git', 'Pull the images of a Git stack', ['pull', '--ignore-buildable', '--ignore-pull-failures'], 600),
  composeGit('compose-config-git', 'Check the compose file of a Git stack', ['config'], 60),
  composeGit('compose-down-git', 'Remove the containers of a Git stack', ['down', '--remove-orphans'], 300),
  composeGit('compose-down-volumes-git', 'Remove the containers and volumes of a Git stack', ['down', '--remove-orphans', '--volumes'], 300),
  cmd('stack-mark', 'Remember the compose file a stack was last deployed with', ['cp', '-f', '--', `${STACKS}/{0}/{1}`, `${STACKS}/{0}/.compose.deployed.yaml`], [P_NAME, P_FILE], { ...priv, timeoutSec: 30 }),
);

/* ---------- containers: webhook redeploy through Watchtower ---------- */

commands.push(
  cmd(
    'container-redeploy',
    'Pull the image of a container and recreate it with the same settings (Watchtower, one run)',
    [...SOCK, 'run', '--rm', '--name', '{0}-redeploy', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-e', 'WATCHTOWER_RUN_ONCE=true', '-e', 'WATCHTOWER_CLEANUP=true', '-e', 'WATCHTOWER_NO_STARTUP_MESSAGE=true', '-e', 'WATCHTOWER_LOG_FORMAT=LogFmt', '{1}', '{0}'],
    [P_CONTAINER, P_IMAGE],
    { ...priv, timeoutSec: 600 },
  ),
);

/* ---------- volume backups ---------- */

const BACKUP_SCRIPT =
  'set -e; f=/out/$(date -u +%Y-%m-%d_%H%M%S).tar; tar -cf "$f.part" -C /v .; mv "$f.part" "$f"; ls -1 /out/*.tar | sort -r | tail -n +$(($1+1)) | xargs -r rm -f --';
commands.push(
  cmd(
    'volume-backup',
    'Write a tar of a volume to the backup folder and delete the oldest ones',
    [...SOCK, 'run', '--rm', '--network', 'none', '-v', '{0}:/v:ro', '-v', `${BACKUP_DIR}/{0}:/out`, HELPER_IMAGE, 'sh', '-c', BACKUP_SCRIPT, 'sh', '{1}'],
    [P_VOLUME, P_KEEP],
    { ...priv, timeoutSec: 600 },
  ),
  cmd('volume-check', 'Check that a volume exists', [...SOCK, 'volume', 'inspect', '--format', '{{.Name}}', '{0}'], [P_VOLUME], { ...priv, timeoutSec: 30 }),
  cmd('volume-backup-ls', 'List the backups of a volume', ['ls', '-l', '--time-style=long-iso', `${BACKUP_DIR}/{0}`], [P_VOLUME], { timeoutSec: 15 }),
);

/* ---------- jobs ---------- */

const param = (name, p, description, def) => ({ name, pattern: p.pattern, maxLen: p.maxLen, description, ...(def ? { default: def } : {}) });
const GIT_PARAMS = [
  param('name', P_NAME, 'Stack name'),
  param('ref', P_REF, 'Branch or tag'),
  param('file', P_FILE, 'Compose file inside the repository', 'compose.yaml'),
];
const NF = ['{param.name}', '{param.file}'];
const LINK = '/p/docker';

/** The four notification choices of a job: n none, s success, f failure, b both. */
const MODES = { n: 'quiet', s: 'notify on success', f: 'notify on failure', b: 'notify on success and failure' };
const wantsOk = (m) => m === 's' || m === 'b';
const wantsFail = (m) => m === 'f' || m === 'b';

function gitPoll(mode) {
  const f = wantsFail(mode);
  const keep = f ? { continueOnError: true } : {};
  const after = (id) => (f ? { if: { step: id, when: 'ok' } } : {});
  const steps = [
    { id: 'fetch', command: 'git-fetch', args: ['{param.name}', '{param.ref}'], ...keep },
    { id: 'head', command: 'git-rev-head', args: ['{param.name}'], ...after('fetch'), ...keep },
    { id: 'new', command: 'git-rev-fetched', args: ['{param.name}'], ...after('fetch'), ...keep },
    { id: 'reset', if: { step: 'new', when: 'differs', other: 'head' }, command: 'git-reset', args: ['{param.name}'], ...keep },
    { id: 'pull', if: { step: 'reset', when: 'ok' }, command: 'compose-pull-git', args: NF, ...keep },
    { id: 'up', if: { step: 'pull', when: 'ok' }, command: 'compose-up-git', args: NF, ...keep },
    { id: 'mark', if: { step: 'up', when: 'ok' }, command: 'stack-mark', args: NF, continueOnError: true },
  ];
  if (wantsOk(mode)) steps.push({ id: 'said', if: { step: 'up', when: 'ok' }, notify: { title: 'Updated {param.name}', body: 'Now at {step.new.stdout}', level: 'success', link: LINK } });
  if (f) {
    for (const [id, what] of [['fetch', 'fetch'], ['reset', 'update the files of'], ['pull', 'pull the images of'], ['up', 'start']]) {
      steps.push({ id: `fail_${id}`, if: { step: id, when: 'failed' }, notify: { title: `Could not ${what} {param.name}`, body: `{step.${id}.stderr}`, level: 'error', link: LINK } });
    }
  }
  return { name: `git-poll-${mode}`, description: `Update a Git stack when its branch or tag moved (${MODES[mode]}).`, timeoutSec: 1800, params: GIT_PARAMS, steps };
}

function backup(mode) {
  const f = wantsFail(mode);
  const keep = f ? { continueOnError: true } : {};
  // Without this check docker would create an empty volume of that name and back up nothing.
  const steps = [
    { id: 'check', command: 'volume-check', args: ['{param.volume}'], ...keep },
    { id: 'run', ...(f ? { if: { step: 'check', when: 'ok' } } : {}), command: 'volume-backup', args: ['{param.volume}', '{param.keep}'], ...keep },
  ];
  if (wantsOk(mode)) steps.push({ id: 'said', if: { step: 'run', when: 'ok' }, notify: { title: 'Backed up volume {param.volume}', level: 'success', link: LINK } });
  if (f) {
    steps.push({ id: 'fail_check', if: { step: 'check', when: 'failed' }, notify: { title: 'Backup of volume {param.volume} failed', body: '{step.check.stderr}', level: 'error', link: LINK } });
    steps.push({ id: 'fail', if: { step: 'run', when: 'failed' }, notify: { title: 'Backup of volume {param.volume} failed', body: '{step.run.stderr}', level: 'error', link: LINK } });
  }
  return {
    name: `volume-backup-${mode}`,
    description: `Write a tar of a volume to the backup folder (${MODES[mode]}).`,
    timeoutSec: 3600,
    params: [param('volume', P_VOLUME, 'Volume name'), param('keep', P_KEEP, 'Backups to keep', '7')],
    steps,
  };
}

const jobs = [
  ...Object.keys(MODES).map(gitPoll),
  {
    name: 'git-redeploy',
    description: 'Pull a Git stack and redeploy it (webhook).',
    timeoutSec: 1800,
    params: GIT_PARAMS,
    steps: [
      { id: 'fetch', command: 'git-fetch', args: ['{param.name}', '{param.ref}'] },
      { id: 'reset', command: 'git-reset', args: ['{param.name}'] },
      { id: 'pull', command: 'compose-pull-git', args: NF },
      { id: 'up', command: 'compose-up-git', args: NF },
      { id: 'mark', if: { step: 'up', when: 'ok' }, command: 'stack-mark', args: NF, continueOnError: true },
    ],
  },
  {
    name: 'stack-redeploy',
    description: 'Pull the images of a stack and redeploy it (webhook).',
    timeoutSec: 1800,
    params: [param('name', P_NAME, 'Stack name')],
    steps: [
      { id: 'pull', command: 'compose-pull', args: ['{param.name}', ''] },
      { id: 'up', command: 'compose-up', args: ['{param.name}', ''] },
    ],
  },
  {
    name: 'container-redeploy',
    description: 'Pull the image of a container and recreate it with the same settings (webhook).',
    timeoutSec: 1800,
    params: [param('name', P_CONTAINER, 'Container name'), param('image', P_IMAGE, 'Watchtower image', 'nickfedor/watchtower:latest')],
    steps: [{ id: 'run', command: 'container-redeploy', args: ['{param.name}', '{param.image}'] }],
  },
  ...Object.keys(MODES).map(backup),
];

/* ---------- write ---------- */

const caps = manifest.capabilities;
const ownCmds = new Set(commands.map((c) => c.name));
caps.commands = [...caps.commands.filter((c) => !ownCmds.has(c.name)), ...commands];
caps.jobs = jobs;
caps.notify = true;

const text = JSON.stringify(manifest, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(file, 'utf8') !== text) {
    console.error('plugin/manifest.json is out of date: run node scripts/gen-manifest.mjs');
    process.exit(1);
  }
} else {
  writeFileSync(file, text);
  console.log(`manifest: ${caps.commands.length} commands, ${jobs.length} jobs`);
}
