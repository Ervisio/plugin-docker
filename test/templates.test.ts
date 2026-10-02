import test from 'node:test';
import assert from 'node:assert/strict';
import { entriesOf, envText, importTemplates, newFileId, parseCustomFile, templateFileText, templateToEntry } from '../src/api/templateModel.ts';
import { emptyForm, formFromTemplate, newEnvForm, seedFromStack, templateFromForm } from '../src/api/templateForm.ts';

const stackForm = () => {
  const f = emptyForm('stack');
  f.name = 'My blog';
  f.description = 'A blog';
  f.categories = 'Blog, CMS';
  f.logo = 'https://example.com/logo.png';
  f.env = [
    newEnvForm({ name: 'HTTP_PORT', value: '8080', ask: true, label: 'Port', type: 'port', required: true }),
    newEnvForm({ name: 'DB_PASSWORD', ask: true, label: 'Database password', type: 'password', generate: true, hint: 'Pick a long one' }),
    newEnvForm({ name: 'THEME', value: 'dark', ask: true, label: 'Theme', options: 'Dark=dark\nLight=light' }),
    newEnvForm({ name: 'TZ', value: 'Europe/Rome' }),
  ];
  return f;
};

test('a stack template survives save and load', () => {
  const r = templateFromForm(stackForm());
  assert.deepEqual(r.problems, []);
  const text = templateFileText(r.template!);
  const back = parseCustomFile('my-blog', text);
  assert.equal(back.id, 'custom:my-blog');
  assert.equal(back.type, 'stack');
  assert.equal(back.name, 'My blog');
  assert.deepEqual(back.categories, ['Blog', 'CMS']);
  assert.equal(back.logo, 'https://example.com/logo.png');
  assert.equal(back.compose, r.template!.compose);
  assert.deepEqual(back.fixedEnv, [{ key: 'TZ', value: 'Europe/Rome' }]);
  const port = back.variables.find((v) => v.name === 'HTTP_PORT')!;
  assert.equal(port.type, 'port');
  assert.equal(port.required, true);
  const pw = back.variables.find((v) => v.name === 'DB_PASSWORD')!;
  assert.equal(pw.type, 'password');
  assert.equal(pw.generate, true);
  assert.equal(pw.hint, 'Pick a long one');
  const theme = back.variables.find((v) => v.name === 'THEME')!;
  assert.deepEqual(theme.options, [{ label: 'Dark', value: 'dark' }, { label: 'Light', value: 'light' }]);
  assert.equal(theme.default, 'dark');
  // the form reads it back the same
  assert.deepEqual(templateFromForm(formFromTemplate(back), back).problems, []);
});

test('the file is a Portainer v3 list with Portainer field names', () => {
  const t = templateFromForm(stackForm()).template!;
  const doc = JSON.parse(templateFileText(t));
  assert.equal(doc.version, '3');
  const e = doc.templates[0];
  assert.equal(e.type, 3);
  assert.equal(e.title, 'My blog');
  assert.deepEqual(e.categories, ['Blog', 'CMS']);
  assert.equal(e.logo, 'https://example.com/logo.png');
  assert.equal(e.platform, 'linux');
  const theme = e.env.find((x: any) => x.name === 'THEME');
  assert.deepEqual(theme.select, [{ text: 'Dark', value: 'dark', default: true }, { text: 'Light', value: 'light' }]);
  assert.equal(e.env.find((x: any) => x.name === 'TZ').preset, true);
});

test('a container template survives save and load', () => {
  const f = emptyForm('container');
  f.name = 'Web';
  f.image = 'nginx:1.27';
  f.ports = '${HTTP_PORT}:80/tcp\n53:53/udp';
  f.volumes = '/srv/www:/usr/share/nginx/html:ro\n/data';
  f.labels = 'a.b=c';
  f.privileged = true;
  f.env = [newEnvForm({ name: 'HTTP_PORT', value: '8080', ask: true, label: 'Port', type: 'port' }), newEnvForm({ name: 'MODE', value: 'prod' })];
  const r = templateFromForm(f);
  assert.deepEqual(r.problems, []);
  const e = templateToEntry(r.template!);
  assert.equal(e.type, 1);
  assert.equal(e.image, 'nginx:1.27');
  assert.deepEqual(e.ports, ['${HTTP_PORT}:80/tcp', '53:53/udp']);
  assert.deepEqual(e.volumes, [{ container: '/usr/share/nginx/html', bind: '/srv/www', readonly: true }, { container: '/data' }]);
  const back = parseCustomFile('web', templateFileText(r.template!));
  assert.equal(back.container!.image, 'nginx:1.27');
  assert.equal(back.container!.privileged, true);
  assert.deepEqual(back.container!.env, [{ key: 'HTTP_PORT', value: '${HTTP_PORT}' }, { key: 'MODE', value: 'prod' }]);
  assert.equal(back.container!.volumes[0].readOnly, true);
});

test('the form reports what is wrong', () => {
  const f = emptyForm('container');
  f.ports = 'abc';
  f.volumes = 'nonsense';
  f.env = [newEnvForm({ name: '1bad' }), newEnvForm({ name: 'A' }), newEnvForm({ name: 'A' })];
  const keys = templateFromForm(f).problems.map((p) => p.key).sort();
  assert.deepEqual(keys, ['templates.edit.err.envDup', 'templates.edit.err.envName', 'templates.edit.err.image', 'templates.edit.err.port', 'templates.edit.err.title', 'templates.edit.err.volume']);
});

test('import reads Portainer lists, single entries and refuses other JSON', () => {
  const list = JSON.stringify({ version: '2', templates: [{ type: 1, title: 'X', image: 'x:1', description: 'd', categories: ['webserver'], env: [{ name: 'A', label: 'A', default: '1' }] }, { type: 9, title: 'bad' }] });
  const r = importTemplates(list);
  assert.equal(r.templates.length, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.templates[0].variables[0].default, '1');
  assert.equal(entriesOf(JSON.stringify({ type: 1, title: 'Y', image: 'y' })).length, 1);
  assert.throws(() => entriesOf('{"a":1}'));
  assert.throws(() => entriesOf('nope'));
});

test('file names are unique and safe', () => {
  assert.equal(newFileId('My Blog!', []), 'my-blog');
  assert.equal(newFileId('My Blog!', ['my-blog', 'my-blog-2']), 'my-blog-3');
  assert.equal(newFileId('???', []), 'app');
});

test('a stack template from a stack leaves secrets out', () => {
  const t = seedFromStack('shop', 'services:\n  a:\n    image: x\n', 'PORT=80\nDB_PASSWORD=hunter2\n');
  assert.equal(t.variables.find((v) => v.name === 'DB_PASSWORD')!.default, '');
  assert.equal(t.variables.find((v) => v.name === 'PORT')!.default, '80');
  assert.ok(!JSON.stringify(t).includes('hunter2'));
});

test('template deploy writes a valid .env', () => {
  const text = envText({ A: "it's $5", B: 'plain' }, [{ name: 'A', label: 'A', default: '', type: 'text' }, { name: 'B', label: 'B', default: '', type: 'text' }], [{ key: 'C', value: 'x y' }]);
  assert.equal(text, `A="it's \\$5"\nB=plain\nC='x y'\n`);
});
