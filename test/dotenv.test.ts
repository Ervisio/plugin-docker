import test from 'node:test';
import assert from 'node:assert/strict';
import { composeRefs, envFromPairs, envHints, formatValue, maskedText, mergeEnv, parseEnv, parseRows, rowsToText, newVar } from '../src/api/dotenv.ts';

const SAMPLE = `# comment
A=plain value  # trailing
B="dq with \\"esc\\" and \\n newline and \\$ dollar and $A ref"
C='sq with $A literal and \\n backslash'
D="multi
line"
E='multi
line sq'
F=pa$$word
G=\${A}-x
H=\${NOPE:-fallback}
export I=exported
J = spaced
K=a=b=c
L="x" # c
M=
`;

test('parses like compose', () => {
  const { rows, issues } = parseRows(SAMPLE);
  assert.deepEqual(issues, []);
  const v = parseEnv(SAMPLE);
  assert.equal(v.A, 'plain value');
  assert.equal(v.B, 'dq with "esc" and \n newline and $ dollar and $A ref');
  assert.equal(v.C, 'sq with $A literal and \\n backslash');
  assert.equal(v.D, 'multi\nline');
  assert.equal(v.E, 'multi\nline sq');
  assert.equal(v.F, 'pa$word');
  assert.equal(v.G, '${A}-x');
  assert.equal(v.I, 'exported');
  assert.equal(v.J, 'spaced');
  assert.equal(v.K, 'a=b=c');
  assert.equal(v.L, 'x');
  assert.equal(v.M, '');
  assert.equal(rows[0].kind, 'other');
});

test('an untouched file is written back unchanged', () => {
  assert.equal(rowsToText(parseRows(SAMPLE).rows), SAMPLE);
});

test('editing one value leaves the other lines alone', () => {
  const { rows } = parseRows('# hi\nA=1\nB=\'x y\'\n\nC=3\n');
  rows[1].value = '2';
  assert.equal(rowsToText(rows), '# hi\nA=2\nB=\'x y\'\n\nC=3\n');
});

test('formatValue round-trips through the parser', () => {
  const cases = ['', 'simple', 'with space', "it's", 'a"b', 'cost $5', 'pa$$word', '${A}-x', 'two\nlines', ' lead', 'x # y', '\\back', "mix ' and \" and $", 'tab\there'];
  for (const c of cases) {
    for (const q of ['none', 'single', 'double'] as const) {
      const text = `K=${formatValue(c, q)}\n`;
      const got = parseRows(text);
      assert.deepEqual(got.issues, [], text);
      const expect = c; // references stay references; no test case here depends on another variable
      if (!/\$\{/.test(c) || q === 'single') assert.equal(got.rows[0]?.value ?? '', expect, `${JSON.stringify(c)} as ${q}: ${text}`);
    }
  }
});

test('flags bad lines, bad names, duplicates and open quotes', () => {
  const r = parseRows('GOOD=1\nnot a line\n1BAD=2\nGOOD=3\nQ="open\nstill\n');
  const keys = r.issues.map((i) => `${i.line}:${i.key}`);
  assert.deepEqual(keys, ['2:stacks.v.envLine', '3:stacks.v.envName', '4:stacks.v.envDup', '5:stacks.v.envQuote']);
});

test('text after a closing quote is a warning', () => {
  assert.equal(parseRows('A="x" y\n').issues[0].key, 'stacks.v.envTrail');
});

test('a bare name is a warning, not an error', () => {
  const r = parseRows('FROM_SHELL\n');
  assert.equal(r.issues[0].level, 'warn');
});

test('merge adds, replaces and keeps', () => {
  const m = mergeEnv('A=1\n# c\nB=2\n', [{ key: 'A', value: '9' }, { key: 'C', value: 'x y' }, { key: 'B', value: '2' }]);
  assert.equal(m.text, 'A=9\n# c\nB=2\nC=\'x y\'\n');
  assert.deepEqual([m.added, m.replaced, m.kept], [1, 1, 1]);
  assert.equal(mergeEnv('A=1\n', [{ key: 'A', value: '2' }], false).text, 'A=1\n');
});

test('references in a compose file', () => {
  const compose = 'services:\n  a:\n    image: x:${TAG:-1}\n    environment:\n      - P=${PASS}\n      - Q=$Q2\n      - R=$${ESCAPED}\n      - S=${NEED:?set it}\n    # ${COMMENTED}\n';
  const refs = composeRefs(compose);
  assert.deepEqual(refs.map((r) => [r.name, r.optional, r.required]), [['TAG', true, false], ['PASS', false, false], ['Q2', false, false], ['NEED', false, true]]);
  const h = envHints(compose, 'PASS=x\nOLD=1\nTAG=2\n');
  assert.deepEqual(h.missing.map((r) => r.name), ['Q2', 'NEED']);
  assert.deepEqual(h.unused, ['OLD']);
  assert.deepEqual(envHints(compose + '    env_file: .env\n', 'OLD=1\n').unused, []);
});

test('the diff text hides secrets but shows that they changed', () => {
  const a = maskedText('DB_PASSWORD=one\nNAME=x\n');
  const b = maskedText('DB_PASSWORD=two\nNAME=x\n');
  assert.ok(!a.includes('one'));
  assert.notEqual(a, b);
  assert.ok(a.includes('NAME=x'));
});

test('pairs to text', () => {
  assert.equal(envFromPairs([{ key: 'A', value: 'b c' }, { key: '', value: 'skip' }]), "A='b c'\n");
  assert.equal(rowsToText([newVar('X', '1')]), 'X=1\n');
});
