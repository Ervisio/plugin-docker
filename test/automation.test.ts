import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  FILE_PATTERN, REF_PATTERN, URL_PATTERN, composeDirOf, credentialLine, explainGitError, hasSecretInUrl, parseCommit, parseGitMeta, parseLsRemote, parseStatus, repoLabel,
  urlKind, validFile, validRef, validUrl, metaText,
} from '../src/api/gitMeta.ts';
import { parseBackupList, validKeep } from '../src/api/backups.ts';

const manifest = JSON.parse(readFileSync(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));
const cmd = (name: string) => manifest.capabilities.commands.find((c: { name: string }) => c.name === name);

test('plugin/manifest.json is what scripts/gen-manifest.mjs writes', () => {
  execFileSync('node', ['scripts/gen-manifest.mjs', '--check'], { cwd: new URL('..', import.meta.url) });
});

test('the TypeScript patterns are the manifest\'s argument patterns', () => {
  assert.equal(cmd('git-ls-remote').args[1].pattern, URL_PATTERN);
  assert.equal(cmd('git-clone').args[2].pattern, REF_PATTERN);
  assert.equal(cmd('compose-up-git').args[1].pattern, FILE_PATTERN);
  assert.ok(URL_PATTERN.length <= 256);
});

test('every job step names a declared command with one argument per declared slot', () => {
  const names = new Set(manifest.capabilities.commands.map((c: { name: string }) => c.name));
  assert.ok(manifest.capabilities.notify);
  assert.ok(manifest.capabilities.jobs.length <= 16);
  for (const job of manifest.capabilities.jobs) {
    assert.ok(job.steps.length <= 16, job.name);
    for (const s of job.steps) {
      if (!s.command) continue;
      assert.ok(names.has(s.command), `${job.name}: ${s.command}`);
      assert.equal(s.args.length, cmd(s.command).args.length, `${job.name}.${s.id}`);
    }
  }
});

test('git commands carry the safety options and never take a secret as an argument', () => {
  for (const c of manifest.capabilities.commands.filter((x: { name: string }) => x.name.startsWith('git-') && x.name !== 'git-version')) {
    const a: string[] = c.argv;
    assert.ok(a.includes('protocol.allow=never'), c.name);
    assert.ok(a.includes('protocol.https.allow=always') && a.includes('protocol.ssh.allow=always'), c.name);
    assert.ok(!a.some((x) => /^protocol\.file/.test(x)) && !a.some((x) => x.includes('ext')), c.name);
    assert.ok(a.some((x) => x.startsWith('credential.helper=store --file ~/.config/ervisio/plugins/docker/git/{0}.cred')), c.name);
    assert.ok(a.some((x) => x.includes('IdentitiesOnly=yes')), c.name);
  }
});

test('repository addresses: allowed and refused', () => {
  for (const ok of ['https://github.com/org/repo.git', 'http://192.168.1.5:3000/o/r', 'ssh://git@host.example:2222/srv/r.git', 'git@github.com:org/repo.git', 'https://gitlab.com/a/b/c.git/']) assert.ok(validUrl(ok), ok);
  for (const bad of ['file:///tmp/x', 'git://host/x', '/tmp/x', 'ext::sh -c id', '-u=x', 'https://', 'https://user:tok@host/x', 'https://host', 'ssh://host/a b', 'https://host/a;rm']) assert.ok(!validUrl(bad), bad);
  assert.equal(urlKind('git@github.com:o/r.git'), 'ssh');
  assert.equal(urlKind('https://x/y'), 'https');
  assert.equal(urlKind('file:///x'), null);
  assert.ok(hasSecretInUrl('https://user:tok@host/x'));
  assert.ok(!hasSecretInUrl('https://host/x@y'));
});

test('refs and compose paths', () => {
  for (const ok of ['main', 'v1.2.0', 'release/1.2', 'feature_x-1']) assert.ok(validRef(ok), ok);
  for (const bad of ['', '-x', 'a..b', 'a/', 'a b', 'x.lock', '../x', 'a;b']) assert.ok(!validRef(bad), bad);
  for (const ok of ['compose.yaml', 'deploy/compose.yml', 'a/b/c/docker-compose.prod.yaml', 'x@1/y.yaml']) assert.ok(validFile(ok), ok);
  for (const bad of ['../x.yaml', 'a/../b.yaml', '/etc/x.yaml', '.hidden/x.yaml', 'a/.x.yaml', 'compose.json', 'a//b.yaml', 'x.yaml;', '']) assert.ok(!validFile(bad), bad);
  assert.equal(composeDirOf('/opt/stacks/a', 'deploy/prod/compose.yaml'), '/opt/stacks/a/deploy/prod');
  assert.equal(composeDirOf('/opt/stacks/a', 'compose.yaml'), '/opt/stacks/a');
  assert.equal(composeDirOf('/opt/stacks/a'), '/opt/stacks/a');
});

test('stack meta round trip and junk', () => {
  const m = { v: 1 as const, url: 'https://h/x', ref: 'main', compose: 'compose.yaml', auth: 'token' as const, added: 5 };
  assert.deepEqual(parseGitMeta(metaText(m)), { ...m, by: undefined });
  assert.equal(parseGitMeta('not json'), null);
  assert.equal(parseGitMeta('{"url":1}'), null);
  assert.equal(parseGitMeta(null), null);
  assert.equal(parseGitMeta('{"url":"a","ref":"b","compose":"c","auth":"weird"}')?.auth, 'none');
});

test('credential store line for a token', () => {
  assert.equal(credentialLine('https://github.com/o/r.git', 'me', 'ghp_abc'), 'https://me:ghp_abc@github.com\n');
  assert.equal(credentialLine('http://10.0.0.1:3000/o/r', '', 'p@ss:w/rd'), 'http://git:p%40ss%3Aw%2Frd@10.0.0.1:3000\n');
  assert.equal(credentialLine('ssh://git@h/x', 'u', 't'), null);
  assert.ok(!credentialLine('https://h/x', 'u', "a'b(c)")!.includes("'"));
});

test('ls-remote output', () => {
  const r = parseLsRemote('ref: refs/heads/main\tHEAD\n' + 'a'.repeat(40) + '\tHEAD\n' + 'a'.repeat(40) + '\trefs/heads/main\n' + 'b'.repeat(40) + '\trefs/heads/dev/x\n' + 'c'.repeat(40) + '\trefs/tags/v1\n' + 'd'.repeat(40) + '\trefs/tags/v1^{}\n');
  assert.deepEqual(r, { head: 'main', branches: ['main', 'dev/x'], tags: ['v1'] });
});

test('git log and status output', () => {
  assert.deepEqual(parseCommit('0123456789abcdef0123456789abcdef01234567\u001fAnn\u001f2026-10-02T18:59:19+02:00\u001fFix: a thing\n'), { hash: '0123456789abcdef0123456789abcdef01234567', author: 'Ann', date: '2026-10-02T18:59:19+02:00', subject: 'Fix: a thing' });
  assert.equal(parseCommit('fatal: x'), null);
  assert.deepEqual(parseStatus(' M deploy/compose.yaml\n M README.md\n'), ['deploy/compose.yaml', 'README.md']);
  assert.deepEqual(parseStatus(''), []);
});

test('git errors are explained', () => {
  assert.equal(explainGitError("fatal: could not read Username for 'https://x': No such device or address").key, 'git.err.auth');
  assert.equal(explainGitError('git@h: Permission denied (publickey).').key, 'git.err.ssh');
  assert.equal(explainGitError("fatal: repository 'https://x/y/' not found").key, 'git.err.notFound');
  assert.equal(explainGitError('fatal: Could not resolve host: x').key, 'git.err.network');
  assert.equal(explainGitError("fatal: couldn't find remote ref nope").key, 'git.err.ref');
  assert.equal(explainGitError("fatal: destination path '/opt/stacks/a' already exists and is not an empty directory.").key, 'git.err.exists');
  assert.equal(explainGitError('boom').key, 'git.err.other');
});

test('repository labels', () => {
  assert.equal(repoLabel('https://github.com/org/repo.git'), 'github.com/org/repo');
  assert.equal(repoLabel('git@github.com:org/repo.git'), 'github.com/org/repo');
  assert.equal(repoLabel('ssh://git@host:2222/srv/r.git'), 'host:2222/srv/r');
});

test('volume backup listing and retention number', () => {
  const out = 'total 8\n-rw-r--r-- 1 root root 4096 2026-10-02 19:17 2026-10-02_171701.tar\n-rw-r--r-- 1 root root 10240 2026-10-03 03:30 2026-10-03_013000.tar\n-rw-r--r-- 1 root root 1 2026-10-03 03:30 notes.txt\n';
  assert.deepEqual(parseBackupList(out), [
    { name: '2026-10-03_013000.tar', size: 10240, when: '2026-10-03 03:30' },
    { name: '2026-10-02_171701.tar', size: 4096, when: '2026-10-02 19:17' },
  ]);
  assert.ok(validKeep('7') && validKeep('365'));
  assert.ok(!validKeep('0') && !validKeep('1000') && !validKeep('') && !validKeep('1e2'));
});

test('the backup script keeps the newest N (run in a shell)', () => {
  const script = cmd('volume-backup').argv.find((a: string) => a.startsWith('set -e;'));
  assert.ok(script);
  // Run the retention part on a temporary folder with the same commands the helper container has.
  const dir = execFileSync('mktemp', ['-d']).toString().trim();
  try {
    for (const d of ['2026-01-01_000001', '2026-01-02_000001', '2026-01-03_000001', '2026-01-04_000001']) execFileSync('sh', ['-c', `echo x > ${dir}/${d}.tar`]);
    const keep = script.slice(script.indexOf('ls -1'));
    execFileSync('sh', ['-c', keep.replace(/\/out\//g, `${dir}/`), 'sh', '2']);
    const left = execFileSync('ls', [dir]).toString().trim().split('\n');
    assert.deepEqual(left, ['2026-01-03_000001.tar', '2026-01-04_000001.tar']);
  } finally {
    execFileSync('rm', ['-rf', dir]);
  }
});
