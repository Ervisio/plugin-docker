import test from 'node:test';
import assert from 'node:assert/strict';
import { BackupError, buildBackup, hasChanges, parseBackup, planImport, type Current } from '../src/api/backupModel.ts';

const cur = (): Current => ({
  registries: [{ id: 'a', server: 'ghcr.io', username: 'me', password: 'secret1' }],
  customTemplates: [{ file: 'blog', doc: { version: '3', templates: [{ title: 'Blog' }] } }],
  templateSources: [{ id: 'x', name: 'X', url: 'https://raw.githubusercontent.com/x/y/t.json', enabled: true }],
  alertRules: [{ id: 'r1', kind: 'stopped', enabled: true }],
  autoUpdate: { enabled: false, schedule: { type: 'daily', hour: 4, minute: 0, day: 0, cron: '' }, mode: 'all', containers: [], cleanup: true, includeStopped: false, monitorOnly: false, rolling: false, image: '' },
  preferences: { stacksDir: '/opt/stacks', liveStats: true, watchtowerImage: 'w' },
});

test('export leaves passwords out when asked', () => {
  const b = buildBackup(cur(), { passwords: false });
  assert.equal(b.registries[0].password, '');
  assert.equal(b.includesPasswords, false);
  assert.ok(!JSON.stringify(b).includes('secret1'));
  assert.equal(buildBackup(cur(), { passwords: true }).registries[0].password, 'secret1');
});

test('a backup reads back and carries a version', () => {
  const b = parseBackup(JSON.stringify(buildBackup(cur(), { passwords: true })));
  assert.equal(b.version, 1);
  assert.equal(b.registries.length, 1);
  assert.equal(b.customTemplates[0].file, 'blog');
  assert.equal(b.alertRules[0].id, 'r1');
});

test('files that are not backups are refused with a reason', () => {
  assert.throws(() => parseBackup('nope'), (e) => e instanceof BackupError && e.key === 'backup.err.json');
  assert.throws(() => parseBackup('{"a":1}'), (e) => e instanceof BackupError && e.key === 'backup.err.format');
  assert.throws(() => parseBackup('{"format":"ervisio-docker-settings","version":99}'), (e) => e instanceof BackupError && e.key === 'backup.err.newer');
});

test('import counts added, replaced and unchanged, and applies nothing it should not', () => {
  const backup = buildBackup(cur(), { passwords: true });
  const now = cur();
  assert.equal(hasChanges(planImport(backup, now).plan), false);

  backup.registries.push({ id: 'z', server: 'quay.io', username: 'u', password: 'p' });
  backup.registries[0].password = 'changed';
  backup.alertRules.push({ id: 'r2', kind: 'cpu', enabled: true });
  backup.templateSources = [];
  backup.preferences = { stacksDir: '/srv', liveStats: false, watchtowerImage: 'w' };
  const { plan, merged } = planImport(backup, now);
  const by = Object.fromEntries(plan.map((p) => [p.id, p]));
  assert.deepEqual([by.registries.added, by.registries.replaced], [1, 1]);
  assert.deepEqual([by.alertRules.added, by.alertRules.unchanged], [1, 1]);
  assert.equal(by.preferences.replaced, 1);
  assert.equal(merged.registries.length, 2);
  assert.equal(merged.templateSources.length, 1, 'nothing is removed');
  assert.equal(now.registries.length, 1, 'the current data is not modified');
});

test('a registry without a password keeps the one it has', () => {
  const backup = buildBackup(cur(), { passwords: false });
  const { merged, plan } = planImport(backup, cur());
  assert.equal(merged.registries[0].password, 'secret1');
  assert.equal(plan.find((p) => p.id === 'registries')!.unchanged, 1);
});

test('sections can be left out', () => {
  const backup = buildBackup(cur(), { passwords: true });
  backup.alertRules = [{ id: 'new', kind: 'disk', enabled: true }];
  const { merged } = planImport(backup, cur(), ['registries']);
  assert.equal(merged.alertRules.length, 1);
});
