/**
 * POST /build, streamed: the body is a tar build context (or `remote` names a Git URL or a tarball URL) and the answer
 * is JSON lines. The classic builder writes "Step 2/5 : RUN ..." lines in {stream}, then {aux: {ID}} with the image id
 * and "Successfully tagged ...", or {error, errorDetail} when a step fails. This turns those lines into steps.
 */
import { stream, type StreamHandle } from '../../api/engine';
import { registryConfigHeader } from '../../api/registries';
import { JsonLines } from '../../api/streams';
import { buildQuery, type BuildOptions } from './options';

export { MAX_CONTEXT, MAX_RAW_CONTEXT, parsePairs } from './options';
export type { BuildOptions } from './options';

export type BuildSource = { kind: 'tar'; tar: Uint8Array } | { kind: 'remote'; url: string };

export interface BuildStep {
  n: number;
  total: number;
  /** The instruction, for example "RUN apk add curl". */
  title: string;
  lines: string[];
  state: 'running' | 'done' | 'failed' | 'stopped';
}

export interface BuildState {
  /** Output before the first step (context upload, parser messages). */
  pre: string[];
  steps: BuildStep[];
  /** What the builder is doing between lines, for example a layer download. */
  activity: string;
  imageId?: string;
  tagged: string[];
  error?: string;
  cancelled?: boolean;
  finished: boolean;
}

interface BuildLine {
  stream?: string;
  status?: string;
  id?: string;
  progress?: string;
  error?: string;
  errorDetail?: { message?: string };
  aux?: { ID?: string };
}

const STEP = /^Step (\d+)\/(\d+) : (.*)$/;

/** Starts a build and reports the state after every change. close() cancels it: Docker stops when the connection ends. */
export function runBuild(src: BuildSource, opts: BuildOptions, onState: (s: BuildState) => void): StreamHandle {
  const st: BuildState = { pre: [], steps: [], activity: '', tagged: [], finished: false };
  let carry = '';
  let handle: StreamHandle | undefined;
  let cancelled = false;
  const emit = () => onState({ ...st, pre: [...st.pre], steps: st.steps.map((s) => ({ ...s, lines: [...s.lines] })), tagged: [...st.tagged] });
  const cur = (): BuildStep | undefined => st.steps[st.steps.length - 1];

  const addLine = (line: string) => {
    const m = STEP.exec(line);
    if (m) {
      const prev = cur();
      if (prev && prev.state === 'running') prev.state = 'done';
      st.steps.push({ n: +m[1], total: +m[2], title: m[3], lines: [], state: 'running' });
      return;
    }
    let m2: RegExpExecArray | null;
    if ((m2 = /^Successfully built ([0-9a-f]+)/.exec(line))) st.imageId = st.imageId ?? m2[1];
    else if ((m2 = /^Successfully tagged (.+)$/.exec(line))) st.tagged.push(m2[1]);
    (cur()?.lines ?? st.pre).push(line);
  };

  const finish = (error?: string) => {
    if (st.finished) return;
    if (st.cancelled) {
      const c = cur();
      if (c && c.state === 'running') c.state = 'stopped';
    } else if (error) {
      st.error = error;
      const c = cur();
      if (c && c.state === 'running') c.state = 'failed';
    } else {
      const c = cur();
      if (c && c.state === 'running') c.state = 'done';
    }
    st.finished = true;
    st.activity = '';
    emit();
  };

  const lines = new JsonLines<BuildLine>(
    (l) => {
      if (l.error || l.errorDetail) {
        finish(l.errorDetail?.message || l.error);
        return;
      }
      if (l.aux?.ID) st.imageId = l.aux.ID.replace(/^sha256:/, '').slice(0, 12);
      if (l.stream !== undefined) {
        st.activity = '';
        carry += l.stream;
        let i: number;
        while ((i = carry.indexOf('\n')) >= 0) {
          const line = carry.slice(0, i).replace(/\r/g, '');
          carry = carry.slice(i + 1);
          if (line.trim()) addLine(line);
        }
      } else if (l.status) {
        st.activity = [l.id, l.status, l.progress].filter(Boolean).join(' ');
      }
      emit();
    },
    (bad) => {
      (cur()?.lines ?? st.pre).push(bad);
      emit();
    },
  );

  void registryConfigHeader()
    .catch(() => undefined)
    .then((cfg) => {
      if (cancelled) return;
      handle = stream(
        'POST',
        '/build',
        {
          query: buildQuery(opts, src.kind === 'remote' ? src.url : undefined),
          headers: { ...(src.kind === 'tar' ? { 'Content-Type': 'application/x-tar' } : {}), ...(cfg ? { 'X-Registry-Config': cfg } : {}) },
          body: src.kind === 'tar' ? src.tar : undefined,
        },
        {
          onData: (c) => lines.push(c),
          onEnd: () => {
            lines.end();
            if (carry.trim()) addLine(carry.trim());
            carry = '';
            finish();
          },
          onError: (e) => finish(e.message),
        },
      );
    });
  emit();
  return {
    close() {
      cancelled = true;
      handle?.close();
      if (!st.finished) {
        st.cancelled = true;
        finish();
      }
    },
  };
}
