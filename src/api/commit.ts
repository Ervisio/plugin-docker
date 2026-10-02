/** Commit a container to an image: POST /commit. Pure helpers (parseChanges, checkRef) are tested on their own. */
import { docker } from './engine';

/** The Dockerfile instructions the Engine accepts in `changes`. */
export const CHANGE_KEYWORDS = ['CMD', 'ENTRYPOINT', 'ENV', 'EXPOSE', 'LABEL', 'ONBUILD', 'USER', 'VOLUME', 'WORKDIR', 'HEALTHCHECK', 'STOPSIGNAL'] as const;

export interface ParsedChanges {
  /** One entry per instruction, in order. */
  lines: string[];
  /** The first line that is not an accepted instruction, 1-based. */
  badLine?: number;
}

/** Splits the changes box into instructions. Empty lines and # comments are ignored. */
export function parseChanges(text: string): ParsedChanges {
  const lines: string[] = [];
  let badLine: number | undefined;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const kw = line.split(/\s+/, 1)[0].toUpperCase();
    if (!(CHANGE_KEYWORDS as readonly string[]).includes(kw) || line.split(/\s+/).length < 2) badLine ??= i + 1;
    lines.push(line);
  });
  return { lines, badLine };
}

const REPO_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const HOST_RE = /^[a-zA-Z0-9.-]+(?::\d+)?$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Checks the repository ("myapp", "me/myapp", "registry.local:5000/me/myapp") and the tag. Returns an i18n key or ''. */
export function checkRef(repo: string, tag: string): string {
  const r = repo.trim();
  if (!r) return 'commit.err.repo';
  const parts = r.split('/');
  const first = parts[0];
  const hasHost = parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  const path = hasHost ? parts.slice(1).join('/') : r;
  if ((hasHost && !HOST_RE.test(first)) || !REPO_RE.test(path)) return 'commit.err.repo';
  if (tag.trim() && !TAG_RE.test(tag.trim())) return 'commit.err.tag';
  return '';
}

export interface CommitOptions {
  repo: string;
  tag: string;
  comment?: string;
  author?: string;
  pause: boolean;
  changes: string[];
}

/** POST /commit. Returns the id of the new image. */
export async function commitContainer(id: string, o: CommitOptions): Promise<string> {
  const query: Record<string, string | string[]> = { container: id, repo: o.repo.trim(), tag: o.tag.trim() || 'latest', pause: o.pause ? 'true' : 'false' };
  if (o.comment?.trim()) query.comment = o.comment.trim();
  if (o.author?.trim()) query.author = o.author.trim();
  if (o.changes.length) query.changes = o.changes;
  const r = await docker.post<{ Id: string }>('/commit', query);
  return r.Id;
}
