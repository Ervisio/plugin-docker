/**
 * Docker Engine client over sdk.api.http('docker', ...). The API version is negotiated once with GET /version
 * (an unversioned path), then every call goes to /v{ApiVersion}/... Pass paths WITHOUT the version prefix:
 *
 *   const list = await docker.get<Container[]>('/containers/json', { all: '1' });
 *   await docker.post('/containers/abc/start');
 *
 * Non-2xx answers throw DockerError (status + the Engine's own message). Broker errors (needs_admin, unavailable,
 * forbidden) arrive as PluginError with `code`; classify() turns either kind into something to show.
 */
import { getSdk, type DownloadStarted, type HttpRequest, type HttpResponse, type PluginError, type Query, type UploadHandle, type UploadOptions } from '../sdk';
import { currentEnv, onEnvChange } from './environments';
import type { VersionInfo } from './types';

export const HTTP_NAME = 'docker';

export class DockerError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DockerError';
    this.status = status;
    this.code = status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'engine';
  }
}

export interface RequestOptions {
  query?: Query;
  headers?: Record<string, string>;
  body?: HttpRequest['body'];
}

/** The negotiated API version per environment: a remote engine may be older than this machine's. */
const versions = new Map<string, Promise<VersionInfo>>();
const envKey = (env: string | undefined): string => env ?? '';

/** GET /version once per environment (undefined = this server, never "the open one": ask with engineVersionHere()); a failed attempt is retried by the next call. */
export function engineVersion(env: string | undefined): Promise<VersionInfo> {
  const key = envKey(env);
  let p = versions.get(key);
  if (!p) {
    p = getSdk()
      .api.http(HTTP_NAME, { method: 'GET', path: '/version', ...(env ? { env } : {}) })
      .then((r) => {
        if (r.status >= 400) throw toError(r);
        return r.json() as VersionInfo;
      })
      .catch((e) => {
        if (versions.get(key) === p) versions.delete(key);
        throw e;
      });
    versions.set(key, p);
  }
  return p;
}

/** The negotiated version of the open environment. */
export const engineVersionHere = (): Promise<VersionInfo> => engineVersion(currentEnv());

/** Forget the negotiated version of the current environment (after a reconnect, or when the engine was upgraded). */
export function resetEngine(): void {
  versions.delete(envKey(currentEnv()));
}

async function versioned(path: string, env: string | undefined): Promise<string> {
  const v = await engineVersion(env);
  return `/v${v.ApiVersion}${path}`;
}

function toError(r: HttpResponse): DockerError {
  let msg = '';
  try {
    msg = (r.json() as { message?: string }).message ?? '';
  } catch {
    msg = r.body?.slice(0, 300) ?? '';
  }
  return new DockerError(r.status, msg || `Docker answered ${r.status}`);
}

/** Raw request: returns the response even for 4xx/5xx. */
export function request(method: string, path: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  return requestIn(currentEnv(), method, path, opts);
}

/** Same for one environment that is not the open one (the Environments page asks every host). undefined = this server. */
export async function requestIn(env: string | undefined, method: string, path: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  return getSdk().api.http(HTTP_NAME, { method, path: await versioned(path, env), ...opts, ...(env ? { env } : {}) });
}

/** Request that throws DockerError for non-2xx and returns the decoded JSON body (or undefined when empty). */
export async function json<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const r = await request(method, path, opts);
  if (r.status >= 400) throw toError(r);
  if (!r.body) return undefined as T;
  try {
    return r.json() as T;
  } catch {
    return r.body as unknown as T;
  }
}

export interface StreamHandle {
  close(): void;
}

export interface StreamHandlers {
  onStart?(status: number, headers: Record<string, string>): void;
  onData(chunk: Uint8Array): void;
  onEnd?(): void;
  onError?(e: Error): void;
}

/** Streamed request (logs, stats, events, pull progress). A status of 400 or more ends the stream with onError. */
export function stream(method: string, path: string, opts: RequestOptions, h: StreamHandlers): StreamHandle {
  let closed = false;
  let inner: { close(): void } | undefined;
  const env = currentEnv();
  versioned(path, env)
    .then((p) => {
      if (closed) return;
      let failed = false;
      let errBody = '';
      inner = getSdk().api.httpStream(HTTP_NAME, { method, path: p, ...opts, ...(env ? { env } : {}) }, {
        onStart: (status, headers) => {
          if (status >= 400) failed = true;
          else h.onStart?.(status, headers);
        },
        onData: (chunk) => {
          if (failed) errBody += new TextDecoder().decode(chunk);
          else h.onData(chunk);
        },
        onEnd: () => {
          if (failed) {
            let msg = errBody;
            try {
              msg = JSON.parse(errBody).message ?? errBody;
            } catch {
              /* plain text */
            }
            h.onError?.(new DockerError(500, msg || 'Docker refused the request'));
          } else h.onEnd?.();
        },
        onError: (e) => h.onError?.(e),
      });
    })
    .catch((e) => h.onError?.(e));
  return {
    close() {
      closed = true;
      inner?.close();
    },
  };
}

/**
 * Large transfers (SDK 0.2, no size limit): the browser saves the answer of a GET as a file, or sends a Blob as the body of a
 * POST or PUT. These do not buffer the data in the frame. download() resolves when the browser starts saving;
 * upload() when the Engine has answered (a non-2xx status is a normal result: use uploadOk() to turn it into an error).
 */
export async function download(path: string, query: Query | undefined, filename: string): Promise<DownloadStarted> {
  const env = currentEnv();
  return getSdk().api.download(HTTP_NAME, { method: 'GET', path: await versioned(path, env), query, ...(env ? { env } : {}) }, filename);
}

/** Starts an upload; the handle has cancel(). The path is versioned when the request is sent. */
export function upload(method: 'POST' | 'PUT', path: string, opts: { query?: Query; headers?: Record<string, string> }, file: Blob, h?: UploadOptions | UploadOptions['onProgress']): UploadHandle {
  let inner: UploadHandle | undefined;
  let cancelled = false;
  const env = currentEnv();
  const p = versioned(path, env).then((v) => {
    if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    inner = getSdk().api.upload(HTTP_NAME, { method, path: v, query: opts.query, headers: opts.headers, ...(env ? { env } : {}) }, file, h);
    return inner;
  }) as UploadHandle;
  p.cancel = () => {
    cancelled = true;
    inner?.cancel();
  };
  return p;
}

/** The text of an Engine error answer (JSON {message} or plain text). */
export function engineMessage(r: { status: number; body?: string }): string {
  let msg = r.body ?? '';
  try {
    msg = (JSON.parse(msg) as { message?: string }).message ?? msg;
  } catch {
    /* plain text */
  }
  return msg.slice(0, 300) || `Docker answered ${r.status}`;
}

/** JSON from one environment that is not the open one. */
export async function jsonIn<T = unknown>(env: string | undefined, path: string, query?: Query): Promise<T> {
  const r = await requestIn(env, 'GET', path, { query });
  if (r.status >= 400) throw toError(r);
  return r.json() as T;
}

export const docker = {
  get: <T = unknown>(path: string, query?: Query) => json<T>('GET', path, { query }),
  post: <T = unknown>(path: string, query?: Query, body?: HttpRequest['body']) => json<T>('POST', path, { query, body }),
  put: <T = unknown>(path: string, query?: Query, body?: HttpRequest['body']) => json<T>('PUT', path, { query, body }),
  delete: <T = unknown>(path: string, query?: Query) => json<T>('DELETE', path, { query }),
  request,
  json,
  stream,
  download,
  upload,
};

/* ---------- errors ---------- */

export type ErrorKind = 'unreachable' | 'forbidden' | 'admin' | 'engine' | 'unknown';

export interface ErrorInfo {
  kind: ErrorKind;
  message: string;
}

/** Sorts any thrown value into something a view can react to. */
export function classify(e: unknown): ErrorInfo {
  const err = e as Partial<PluginError> | undefined;
  const message = err?.message ?? String(e);
  if (e instanceof DockerError) return { kind: 'engine', message };
  switch (err?.code) {
    case 'needs_admin':
      return { kind: 'admin', message };
    case 'forbidden':
      return { kind: 'forbidden', message };
    case 'unavailable':
    case 'not_found':
      return { kind: 'unreachable', message };
    default:
      return { kind: /ECONNREFUSED|no such file|connect/i.test(message) ? 'unreachable' : 'unknown', message };
  }
}

/** The text to put in a toast for a failed action. */
export const errorText = (e: unknown): string => classify(e).message;

/** A switch of environment closes nothing by itself: streams are closed by their owners (views unmount). Versions of
 *  environments that are no longer wanted are dropped here so a re-added host is negotiated again. */
onEnvChange(() => {
  if (versions.size > 8) versions.clear();
});
