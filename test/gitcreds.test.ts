import test from 'node:test';
import assert from 'node:assert/strict';
import { setSdk } from '../src/sdk.ts';
import { setEnv, setKnownEnvs } from '../src/api/environments.ts';
import { GIT_AUTH_DIR, GitError, LEGACY_CRED_DIR, lsRemote, removeCredentials, storeCredentials } from '../src/api/git.ts';
import { credentialLine } from '../src/api/gitMeta.ts';

const notFound = () => Object.assign(new Error('not_found'), { code: 'not_found' });

/** An in-memory server: files, folders, and the declared commands the credential code runs. */
function mockServer() {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/opt/stacks']);
  const log: string[] = [];
  const opts: { path: string; rest: unknown[] }[] = [];
  const state = { lockExit: 0, lsStderr: "fatal: could not read Username for 'https://github.com': No such device or address", listFail: new Set<string>() };
  const seen = (path: string, rest: unknown[]) => opts.push({ path, rest });
  setSdk({
    files: {
      list: async (p: string, ...rest: unknown[]) => {
        seen(p, rest);
        if (state.listFail.has(p)) throw Object.assign(new Error('needs_admin'), { code: 'needs_admin' });
        if (!dirs.has(p)) throw notFound();
        return [...files.keys()].filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/')).map((k) => ({ name: k.slice(p.length + 1), type: 'file' }));
      },
      read: async (p: string, ...rest: unknown[]) => {
        seen(p, rest);
        if (!files.has(p)) throw notFound();
        return files.get(p)!;
      },
      write: async (p: string, d: string, ...rest: unknown[]) => {
        seen(p, rest);
        log.push(`write ${p}`);
        files.set(p, d);
      },
      mkdir: async (p: string, ...rest: unknown[]) => {
        seen(p, rest);
        dirs.add(p);
      },
      remove: async (p: string, ...rest: unknown[]) => {
        seen(p, rest);
        log.push(`remove ${p}`);
        if (!files.delete(p)) throw notFound();
      },
    },
    api: {
      exec: async (c: string, args: string[]) => {
        log.push(`exec ${c} ${args.join(' ')}`.trim());
        if (c === 'git-auth-init') {
          dirs.add(GIT_AUTH_DIR);
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (c === 'git-auth-lock') return state.lockExit === 0 ? { exitCode: 0, stdout: '', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'chmod: Operation not permitted' };
        if (c === 'git-ls-remote') return { exitCode: 128, stdout: '', stderr: state.lsStderr };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  } as never);
  return { files, dirs, log, opts, state };
}

/** No call on a login file may carry the { env } of a paired server: the git commands that read them run here. */
const noEnv = (opts: { path: string; rest: unknown[] }[]) => {
  for (const o of opts.filter((x) => x.path.startsWith(GIT_AUTH_DIR) || x.path.startsWith(LEGACY_CRED_DIR))) {
    assert.ok(!o.rest.some((x) => x && typeof x === 'object' && 'env' in (x as object)), o.path);
  }
};

/** The GitError key a git call rejects with, or 'resolved'. */
const keyOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitError);
    return e.key;
  }
  return 'resolved';
};

test('storeCredentials writes the token into the admin login folder and locks it to 600 afterwards', async () => {
  const s = mockServer();
  // A paired Ervisio server is selected: stack files would carry { env }, the login files must not.
  setKnownEnvs([{ id: 'env-bbbbbbbb', name: 'nas', kind: 'ervisio' }] as never);
  setEnv('env-bbbbbbbb');
  try {
    await storeCredentials('web', 'https://github.com/o/r.git', { kind: 'token', username: 'me', secret: ' tok \n' });
    assert.equal(s.files.get(`${GIT_AUTH_DIR}/web.cred`), credentialLine('https://github.com/o/r.git', 'me', 'tok'));
    assert.equal(GIT_AUTH_DIR, '/opt/stacks/.ervisio-git');
    const init = s.log.indexOf('exec git-auth-init');
    const write = s.log.indexOf(`write ${GIT_AUTH_DIR}/web.cred`);
    const lock = s.log.indexOf('exec git-auth-lock web.cred');
    assert.ok(init >= 0 && init < write && write < lock, s.log.join('\n'));
    assert.ok(![...s.files.keys()].some((k) => k.startsWith('~')), 'nothing is written to the home folder');
    noEnv(s.opts);
  } finally {
    setEnv(undefined);
  }
});

test('storeCredentials writes a deploy key, without git-auth-init when the folder exists', async () => {
  const s = mockServer();
  s.dirs.add(GIT_AUTH_DIR);
  await storeCredentials('app', 'git@github.com:o/r.git', { kind: 'ssh', secret: '-----BEGIN KEY-----\r\nabc\r\n-----END KEY-----\r\n\r\n' });
  assert.equal(s.files.get(`${GIT_AUTH_DIR}/app.key`), '-----BEGIN KEY-----\nabc\n-----END KEY-----\n');
  assert.ok(!s.log.includes('exec git-auth-init'));
  assert.ok(s.log.indexOf(`write ${GIT_AUTH_DIR}/app.key`) < s.log.indexOf('exec git-auth-lock app.key'));
  noEnv(s.opts);
});

test('storeCredentials removes the file and rejects when it cannot be locked', async () => {
  const s = mockServer();
  s.dirs.add(GIT_AUTH_DIR);
  s.state.lockExit = 1;
  await assert.rejects(storeCredentials('bad', 'https://h/x', { kind: 'token', username: 'u', secret: 't' }), /Operation not permitted/);
  assert.ok(!s.files.has(`${GIT_AUTH_DIR}/bad.cred`));
});

test('storeCredentials with no login writes nothing and runs no command', async () => {
  const s = mockServer();
  await storeCredentials('web', 'https://h/x', { kind: 'none' });
  assert.equal(s.files.size, 0);
  assert.ok(!s.log.some((l) => l.startsWith('exec')));
});

test('removeCredentials removes the new and the old login files', async () => {
  const s = mockServer();
  s.files.set(`${GIT_AUTH_DIR}/web.cred`, 'x');
  s.files.set(`${LEGACY_CRED_DIR}/web.key`, 'y');
  await removeCredentials('web');
  for (const p of [`${GIT_AUTH_DIR}/web.cred`, `${GIT_AUTH_DIR}/web.key`, `${LEGACY_CRED_DIR}/web.cred`, `${LEGACY_CRED_DIR}/web.key`]) assert.ok(s.log.includes(`remove ${p}`), p);
  assert.equal(s.files.size, 0);
  noEnv(s.opts);
});

test('a missing saved login is told apart from a login git never got', async () => {
  const s = mockServer();
  s.dirs.add(GIT_AUTH_DIR);
  assert.equal(await keyOf(lsRemote('x', 'https://github.com/o/r.git', 'token')), 'git.err.credMissing');
  assert.equal(await keyOf(lsRemote('x', 'https://github.com/o/r.git')), 'git.err.noLogin');
  assert.equal(await keyOf(lsRemote('x', 'https://github.com/o/r.git', 'none')), 'git.err.noLogin');
  s.files.set(`${GIT_AUTH_DIR}/x.cred`, 'https://u:t@github.com\n');
  assert.equal(await keyOf(lsRemote('x', 'https://github.com/o/r.git', 'token')), 'git.err.noLogin');
});

test('a deploy key kept in the old folder and refused stays an ssh error, not a missing login', async () => {
  const s = mockServer();
  s.dirs.add(GIT_AUTH_DIR);
  s.dirs.add(LEGACY_CRED_DIR);
  s.files.set(`${LEGACY_CRED_DIR}/app.key`, 'k');
  s.state.lsStderr = 'Warning: Identity file /opt/stacks/.ervisio-git/app.key not accessible: No such file or directory.\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.';
  assert.equal(await keyOf(lsRemote('app', 'git@github.com:o/r.git', 'ssh')), 'git.err.ssh');
  // Without the old file either, the same failure means the saved key is gone.
  s.files.delete(`${LEGACY_CRED_DIR}/app.key`);
  assert.equal(await keyOf(lsRemote('app', 'git@github.com:o/r.git', 'ssh')), 'git.err.credMissing');
  noEnv(s.opts);
});

test('a login folder that cannot be listed does not turn the git error into a missing login', async () => {
  const s = mockServer();
  s.dirs.add(GIT_AUTH_DIR);
  s.state.listFail.add(GIT_AUTH_DIR);
  assert.equal(await keyOf(lsRemote('x', 'https://github.com/o/r.git', 'token')), 'git.err.noLogin');
  s.state.listFail.clear();
  s.state.listFail.add(LEGACY_CRED_DIR);
  assert.equal(await keyOf(lsRemote('x', 'https://github.com/o/r.git', 'token')), 'git.err.noLogin');
});
