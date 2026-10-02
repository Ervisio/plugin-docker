/**
 * Docker Compose `.env` files: parsing, validation and writing. Pure functions (no SDK), so tests can import them.
 *
 * The rules are the ones `docker compose` follows (checked against Compose 5.x):
 *   NAME=value         unquoted: ends at the end of the line or at " #"; surrounding spaces are dropped; "$$" is a dollar
 *   NAME='value'       literal, nothing is expanded, may span lines
 *   NAME="value"       escapes \n \r \t \" \\ \$, ${OTHER} is expanded, may span lines
 *   export NAME=value  the word export is ignored
 *   NAME               no value: taken from the shell that runs compose
 *   # comment          ignored
 * Names are letters, digits, "_", "." and "-", and do not start with a digit.
 *
 * A file is read into rows. Comments, blank lines and lines that are not variables stay as "other" rows, and a
 * variable you did not touch is written back exactly as it was, so editing one value never reformats the rest.
 */

export type Quote = 'none' | 'single' | 'double';

export interface EnvRow {
  id: string;
  kind: 'var' | 'other';
  key: string;
  /** What the variable means: escapes decoded, "$$" and "\$" turned into "$". ${REFERENCES} stay as typed. */
  value: string;
  quote: Quote;
  /** Source text of the row (one or more lines), written back when key and value are unchanged. */
  raw: string;
  origKey: string;
  origValue: string;
}

export interface EnvIssue {
  /** 1-based line. */
  line: number;
  level: 'error' | 'warn';
  /** i18n key (stacks.v.*) and its variables. */
  key: string;
  vars?: Record<string, string | number>;
}

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
export const isSecretName = (k: string): boolean => /pass|secret|token|key|pwd|credential/i.test(k);

let seq = 0;
export const newRowId = (): string => `e${++seq}`;

const REF = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;
const hasRef = (v: string): boolean => REF.test(v.replace(/\$\$/g, ''));

/** Decode the inside of a double-quoted value. */
function decodeDouble(s: string): string {
  return s.replace(/\\(.)/gs, (m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c === '"' || c === '\\' || c === '$' ? c : m));
}

/** Find the closing quote of a quoted value starting at lines[i] (text after the opening quote in `rest`). */
function scanQuoted(rest: string, lines: string[], i: number, q: '"' | "'"): { inner: string; after: string; end: number } | null {
  let buf = '';
  let cur = rest;
  let li = i;
  for (;;) {
    for (let p = 0; p < cur.length; p++) {
      const c = cur[p];
      if (q === '"' && c === '\\' && p + 1 < cur.length) {
        buf += c + cur[p + 1];
        p++;
        continue;
      }
      if (c === q) return { inner: buf, after: cur.slice(p + 1), end: li };
      buf += c;
    }
    li++;
    if (li >= lines.length) return null;
    buf += '\n';
    cur = lines[li];
  }
}

export interface ParsedEnv {
  rows: EnvRow[];
  issues: EnvIssue[];
}

export function parseRows(text: string): ParsedEnv {
  const rows: EnvRow[] = [];
  const issues: EnvIssue[] = [];
  const src = text.replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const seen = new Map<string, number>();
  const other = (raw: string): void => {
    rows.push({ id: newRowId(), kind: 'other', key: '', value: '', quote: 'none', raw, origKey: '', origValue: '' });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t || t.startsWith('#')) {
      other(line);
      continue;
    }
    const m = /^\s*(?:export\s+)?([^=\s]+)\s*(=)?\s*(.*)$/.exec(line);
    if (!m) {
      issues.push({ line: i + 1, level: 'error', key: 'stacks.v.envLine' });
      other(line);
      continue;
    }
    const [, key, eq, rest] = m;
    if (!eq) {
      if (ENV_NAME.test(key) && !rest) issues.push({ line: i + 1, level: 'warn', key: 'stacks.v.envBare', vars: { name: key } });
      else issues.push({ line: i + 1, level: 'error', key: 'stacks.v.envLine' });
      other(line);
      continue;
    }
    if (!ENV_NAME.test(key)) {
      issues.push({ line: i + 1, level: 'error', key: 'stacks.v.envName', vars: { name: key.length > 30 ? key.slice(0, 30) + '…' : key } });
      other(line);
      continue;
    }
    let value: string;
    let quote: Quote = 'none';
    let end = i;
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const q = rest[0] as '"' | "'";
      const r = scanQuoted(rest.slice(1), lines, i, q);
      if (!r) {
        issues.push({ line: i + 1, level: 'error', key: 'stacks.v.envQuote', vars: { name: key } });
        other(lines.slice(i).join('\n'));
        break;
      }
      quote = q === '"' ? 'double' : 'single';
      value = q === '"' ? decodeDouble(r.inner) : r.inner;
      end = r.end;
      const tail = r.after.trim();
      if (tail && !tail.startsWith('#')) issues.push({ line: end + 1, level: 'warn', key: 'stacks.v.envTrail', vars: { name: key } });
    } else {
      value = rest.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trimEnd().replace(/\$\$/g, '$');
    }
    if (seen.has(key)) issues.push({ line: i + 1, level: 'warn', key: 'stacks.v.envDup', vars: { name: key, line: seen.get(key)! } });
    else seen.set(key, i + 1);
    rows.push({ id: newRowId(), kind: 'var', key, value, quote, raw: lines.slice(i, end + 1).join('\n'), origKey: key, origValue: value });
    i = end;
  }
  return { rows, issues };
}

/** Variables of a text as a map; the last one wins, like compose. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of parseRows(text).rows) if (r.kind === 'var') out[r.key] = r.value;
  return out;
}

export const validateEnv = (text: string): EnvIssue[] => parseRows(text).issues;

/** Value as written in the file for a given quote style (a new row has quote 'none'). */
export function formatValue(value: string, quote: Quote = 'none'): string {
  if (value === '') return '';
  // A row that was single-quoted is literal: ${X} in it is not a reference.
  const refs = quote !== 'single' && hasRef(value);
  if (/^[A-Za-z0-9_.\/:@,+%=-]+$/.test(value)) return value;
  if (quote === 'single' && !value.includes("'")) return `'${value}'`;
  if (!refs && !value.includes("'") && quote !== 'double') return `'${value}'`;
  // Double quotes: keep ${REFERENCES} working, escape what would be misread.
  let out = '';
  for (let p = 0; p < value.length; ) {
    const rm = refs ? new RegExp(`^(?:${REF.source})`).exec(value.slice(p)) : null;
    if (rm) {
      out += rm[0];
      p += rm[0].length;
      continue;
    }
    const c = value[p++];
    out += c === '\\' ? '\\\\' : c === '"' ? '\\"' : c === '$' ? '\\$' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : c;
  }
  return `"${out}"`;
}

export function rowText(r: EnvRow): string {
  if (r.kind === 'other') return r.raw;
  if (r.key === r.origKey && r.value === r.origValue) return r.raw;
  return `${r.key}=${formatValue(r.value, r.quote)}`;
}

/** Text of a file from rows. Variables without a name are left out. */
export function rowsToText(rows: EnvRow[]): string {
  const out = rows.filter((r) => r.kind === 'other' || r.key.trim() !== '').map(rowText);
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.length ? out.join('\n') + '\n' : '';
}

export const newVar = (key = '', value = ''): EnvRow => ({ id: newRowId(), kind: 'var', key, value, quote: 'none', raw: '', origKey: '\0', origValue: '\0' });

/** Text for a list of key/value pairs (templates, container env). */
export const envFromPairs = (pairs: { key: string; value: string }[]): string => rowsToText(pairs.map((p) => newVar(p.key, p.value)));

/** Add or replace variables of an existing text, keeping everything else. `replace: false` leaves existing names alone. */
export function mergeEnv(text: string, add: { key: string; value: string }[], replace = true): { text: string; added: number; replaced: number; kept: number } {
  const { rows } = parseRows(text);
  let added = 0;
  let replaced = 0;
  let kept = 0;
  for (const a of add) {
    if (!ENV_NAME.test(a.key)) continue;
    const at = rows.map((r) => r.kind === 'var' && r.key === a.key).lastIndexOf(true);
    if (at >= 0) {
      if (!replace) kept++;
      else if (rows[at].value !== a.value) {
        rows[at] = { ...rows[at], value: a.value };
        replaced++;
      } else kept++;
    } else {
      rows.push(newVar(a.key, a.value));
      added++;
    }
  }
  return { text: rowsToText(rows), added, replaced, kept };
}

/* ---------- ${VAR} references in a compose file ---------- */

export interface ComposeRef {
  name: string;
  /** Has a default (`${X:-d}`, `${X-d}`) or is optional (`${X:+v}`). */
  optional: boolean;
  /** `${X:?message}`: compose stops when it is empty. */
  required: boolean;
  /** 1-based line of the first use. */
  line: number;
}

export function composeRefs(compose: string): ComposeRef[] {
  const out = new Map<string, ComposeRef>();
  compose.split('\n').forEach((line, idx) => {
    if (/^\s*#/.test(line)) return;
    const s = line.replace(/\$\$/g, '');
    for (const m of s.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = (m[1] ?? m[3])!;
      const rest = m[2] ?? '';
      const optional = /^:?[-+]/.test(rest);
      const required = /^:?\?/.test(rest);
      const prev = out.get(name);
      if (!prev) out.set(name, { name, optional, required, line: idx + 1 });
      else {
        prev.optional = prev.optional && optional;
        prev.required = prev.required || required;
      }
    }
  });
  return [...out.values()];
}

export interface EnvHints {
  /** Used by the compose file with no default and no value in .env. */
  missing: ComposeRef[];
  /** Defined in .env and not used by the compose file. */
  unused: string[];
  /** The compose file has env_file entries, which load .env wholesale: then "unused" means nothing. */
  wholesale: boolean;
}

export function envHints(compose: string, env: string): EnvHints {
  const refs = composeRefs(compose);
  const have = new Set(Object.keys(parseEnv(env)));
  const used = new Set(refs.map((r) => r.name));
  const wholesale = /^\s*env_file\s*:/m.test(compose);
  return {
    missing: refs.filter((r) => !have.has(r.name) && !r.optional),
    unused: wholesale ? [] : [...have].filter((n) => !used.has(n)),
    wholesale,
  };
}

/* ---------- display ---------- */

const hash4 = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0').slice(-4);
};

/**
 * The text with secret values hidden, for the diff. A hidden value is shown as dots plus a short fingerprint, so a
 * changed secret still shows up as a changed line without the diff giving it away.
 */
export function maskedText(text: string, fingerprint = true): string {
  const { rows } = parseRows(text);
  return rows
    .map((r) => (r.kind === 'var' && isSecretName(r.key) && r.value ? `${r.key}=•••••••${fingerprint ? ` (${hash4(r.value)})` : ''}` : r.raw))
    .join('\n') + (rows.length ? '\n' : '');
}
