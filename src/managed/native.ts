/**
 * `--backend native`: the same runs/metrics/logs/files commands against DreamLake-native Experiments
 * (`/native-experiments/ns/:ns/projects/:project/...` on the DreamLake API), selected explicitly per
 * command. Uses the DreamLake login the managed mode already shares; never the standalone Dash login,
 * never a managed BFF or Dash proxy, and no fallback to another backend.
 */
import { createHash } from 'node:crypto';
import { existsSync, linkSync, openAsBlob, readFileSync, statSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { ParsedArgs } from '../cli/parser.js';
import { arg, invalidResponse, ManagementError, record, required, type Context } from './client.js';

/** Commands that have a native implementation, and the actions each supports there. */
export const nativeActions: Record<string, string[]> = {
  auth: ['status', 'login'], instance: ['show', 'capabilities'], health: ['check'], diagnostics: ['check'],
  runs: ['list', 'show', 'create', 'status', 'parameters', 'delete'],
  metrics: ['list', 'read', 'append'], logs: ['read', 'append'], files: ['list', 'inspect', 'upload', 'download'],
};
/** Why the remaining commands have no native form yet; reported instead of falling back. */
const unavailable: Record<string, string> = {
  setup: 'Native projects need no Dash setup; a DreamLake project with native Experiments is ready to use.',
  credentials: 'Native workload credentials are not available yet; native writes use your DreamLake login.',
  adoption: 'Adoption of legacy Dash projects into native storage is a pending backend dependency.',
  connections: 'External Dash connections belong to the managed backend only.',
  workspaces: 'Dash workspace binding belongs to the managed backend only.',
  orgs: 'DreamLake organizations are shared by both backends; omit --backend native.',
  teams: 'DreamLake teams are inspected without --backend; omit --backend native.',
  projects: 'Native project discovery is not wired into ml-dash yet; use DreamLake project commands meanwhile.',
  'instance schema': 'Native Experiments publish no machine operation schema yet.',
};
/** Managed-only review, credential and paging options that have no native meaning. */
const managedOnly = ['apply', 'review', 'idempotency_key', 'credential', 'expected_generation', 'plan_hash', 'offset',
  'remote_project', 'remote_namespace', 'connection', 'expected_revision', 'standalone', 'dash_url'];

const RUN_ID = /^[0-9a-f]{24}$/;
const FILE_ID = /^[0-9a-f]{24}$/;
const METRIC = /^[A-Za-z0-9_.-]{1,128}$/;
const RESPONSE_LIMIT = 12 * 1024 * 1024;

function nativeError(code: string, message: string, remediation: string, retryable = false) {
  return new ManagementError(code, message, remediation, retryable);
}
function runId(a: ParsedArgs) {
  const v = required(a, 'run');
  if (!RUN_ID.test(v)) throw nativeError('NATIVE_INVALID_RUN', '--run must be a DreamLake native run ID.', 'Use the id from runs list or runs create.');
  return v;
}
function fileId(a: ParsedArgs) {
  const v = required(a, 'file');
  if (!FILE_ID.test(v)) throw nativeError('NATIVE_INVALID_FILE', '--file must be a DreamLake native file ID.', 'Use the id from files list.');
  return v;
}
function metric(a: ParsedArgs) {
  const v = required(a, 'metric');
  if (!METRIC.test(v)) throw nativeError('NATIVE_INVALID_METRIC', 'Metric name must be 1-128 letters, digits, ".", "_" or "-".', 'Choose a valid metric name.');
  return v;
}
function load(file: string): unknown {
  try { return JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8')); }
  catch { throw nativeError('NATIVE_INVALID_INPUT', 'Input must be valid JSON.', 'Provide a UTF-8 JSON file or - for stdin.'); }
}
function page(a: ParsedArgs, max: number, cursor: RegExp) {
  const q = new URLSearchParams();
  const limit = arg(a, 'limit'), next = arg(a, 'cursor');
  if (limit !== undefined) {
    if (!/^[1-9]\d*$/.test(limit) || Number(limit) > max) throw nativeError('NATIVE_INVALID_LIMIT', `--limit must be between 1 and ${max}.`, 'Choose a bounded page size.');
    q.set('limit', limit);
  }
  if (next !== undefined) {
    if (!cursor.test(next)) throw nativeError('NATIVE_INVALID_CURSOR', '--cursor must be the nextCursor of the previous page.', 'Pass the server nextCursor unchanged.');
    q.set('cursor', next);
  }
  return q.size ? `?${q}` : '';
}

/** One request to the DreamLake API origin. Redirects are refused, so the bearer never leaves it. */
async function call(c: Context, route: string, method = 'GET', body?: unknown, form?: FormData): Promise<Response> {
  let response: Response;
  const timeout = form ? 30 * 60 * 1000 : 30000;
  try {
    response = await fetch(`${c.url}${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { ...(c.token ? { authorization: `Bearer ${c.token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(form ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch {
    throw nativeError('NATIVE_NETWORK_ERROR', 'Request failed; a write outcome may be unknown.', 'Inspect the run before retrying a write.', true);
  }
  if (!response.ok) {
    let code = `NATIVE_HTTP_${response.status}`;
    // Only the server's stable code is reflected, never its body.
    try { const b = await response.json() as any; const candidate = b?.error?.code; if (typeof candidate === 'string' && /^NATIVE_[A-Z0-9_]{1,100}$/.test(candidate)) code = candidate; } catch { /* ignore */ }
    const advice = response.status === 401 ? 'Run ml-dash auth login for this DreamLake environment.' :
      response.status === 403 ? 'Ask the project owner for access to this DreamLake project.' :
      response.status === 404 ? 'Check the namespace, project and IDs, and that the server has native Experiments enabled.' :
      response.status === 409 ? 'Inspect the run state before retrying.' : 'Retry reads; inspect the run before retrying a write.';
    throw nativeError(code, `The native Experiments API rejected the request (HTTP ${response.status}).`, advice, response.status >= 500);
  }
  return response;
}
async function json(c: Context, route: string, method = 'GET', body?: unknown, form?: FormData): Promise<Record<string, any>> {
  const response = await call(c, route, method, body, form);
  try {
    if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) throw invalidResponse();
    const text = await response.text();
    if (text.length > RESPONSE_LIMIT) throw invalidResponse();
    return record(JSON.parse(text));
  } catch { throw invalidResponse(); }
}

async function sha256File(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of (await openAsBlob(file)).stream() as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
  return hash.digest('hex');
}

export function assertNativeSelection(name: string, act: string, a: ParsedArgs) {
  const reason = unavailable[`${name} ${act}`] ?? (nativeActions[name] ? undefined : unavailable[name]);
  if (reason || !nativeActions[name]?.includes(act))
    throw nativeError('NATIVE_NOT_AVAILABLE', `${name} ${act} has no native Experiments form.`, reason ?? 'Use one of the actions listed for native mode in the README.');
  const bad = managedOnly.filter(k => a[k] !== undefined && a[k] !== false);
  if (bad.length) throw nativeError('NATIVE_OPTION_UNSUPPORTED', `--${bad[0]!.replace(/_/g, '-')} is a managed-backend option.`,
    'Native writes apply directly with your DreamLake login; remove the managed review, credential or paging options.');
}

export async function nativeCommand(name: string, act: string, c: Context, a: ParsedArgs): Promise<unknown> {
  const base = () => `/native-experiments/ns/${encodeURIComponent(required(a, 'namespace'))}/projects/${encodeURIComponent(required(a, 'project'))}`;
  const run = () => `${base()}/runs/${runId(a)}`;
  if (name === 'auth') {
    const me = record(await json(c, '/auth/me'));
    return { authenticated: true, server: c.url, backend: 'native', user: me.user ?? me, credentialSource: 'DreamLake shared login' };
  }
  if (name === 'instance' || name === 'health' || name === 'diagnostics') {
    const status = await json(c, `${base()}/status`);
    return name === 'instance' ? status : { status: status.status, backend: 'native', server: c.url, project: status };
  }
  if (name === 'runs') {
    if (act === 'list') return json(c, `${base()}/runs${page(a, 100, RUN_ID)}`);
    if (act === 'show') return json(c, run());
    if (act === 'create') {
      const key = required(a, 'run_key');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw nativeError('NATIVE_INVALID_RUN_KEY', 'Run key must contain 1-128 letters, numbers, underscores or hyphens.', 'Choose a stable idempotent run key.');
      return json(c, `${base()}/runs/${encodeURIComponent(key)}`, 'PUT', {});
    }
    if (act === 'status') return json(c, `${run()}/status`, 'POST', { status: required(a, 'status') });
    if (act === 'parameters') {
      if (!arg(a, 'data')) return json(c, `${run()}/parameters`);
      const data = load(required(a, 'data'));
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length)
        throw nativeError('NATIVE_INVALID_PARAMETERS', 'Parameters must be a non-empty JSON object.', 'Provide a JSON object.');
      return json(c, `${run()}/parameters`, 'POST', { data });
    }
    return json(c, run(), 'DELETE');
  }
  if (name === 'metrics') {
    if (act === 'list') return json(c, `${run()}/metrics`);
    if (act === 'read') return json(c, `${run()}/metrics/${encodeURIComponent(metric(a))}${page(a, 1000, /^(0|[1-9]\d*)$/)}`);
    const points = load(required(a, 'data'));
    if (!Array.isArray(points) || !points.length || points.length > 1000 || points.some(p => !p || typeof p !== 'object' || Array.isArray(p)))
      throw nativeError('NATIVE_INVALID_METRICS', 'Metric data must be a JSON array of 1-1000 objects.', 'Provide a bounded JSON array.');
    // The descriptor is stored with the points only when this append creates the metric.
    const descriptor: Record<string, unknown> = {};
    if (arg(a, 'description') !== undefined) descriptor.description = arg(a, 'description') || null;
    if (arg(a, 'tags') !== undefined) descriptor.tags = arg(a, 'tags')!.split(',').map(t => t.trim()).filter(Boolean);
    if (arg(a, 'metadata') !== undefined) {
      const value = load(arg(a, 'metadata')!);
      if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw nativeError('NATIVE_INVALID_METRICS', '--metadata must contain a JSON object or null.', 'Provide a JSON object.');
      descriptor.metadata = value;
    }
    return json(c, `${run()}/metrics/${encodeURIComponent(metric(a))}`, 'POST', { dataPoints: points, ...descriptor });
  }
  if (name === 'logs') {
    if (act === 'read') return json(c, `${run()}/logs${page(a, 1000, /^(0|[1-9]\d*)$/)}`);
    const entries = load(required(a, 'data'));
    if (!Array.isArray(entries) || !entries.length || entries.length > 1000) throw nativeError('NATIVE_INVALID_LOGS', 'Logs must contain 1-1000 entries.', 'Provide a bounded JSON array.');
    return json(c, `${run()}/logs`, 'POST', { entries });
  }
  // files
  if (act === 'list') return json(c, `${run()}/files`);
  if (act === 'inspect') return json(c, `${run()}/files/${fileId(a)}`);
  if (act === 'upload') {
    const input = required(a, 'input');
    let size: number;
    try { const info = statSync(input); if (!info.isFile()) throw new Error(); size = info.size; }
    catch { throw nativeError('NATIVE_FILE_UNREADABLE', 'Cannot read the selected upload file.', 'Choose a readable regular file.'); }
    const contentType = arg(a, 'content_type') || 'application/octet-stream';
    const checksum = await sha256File(input);
    const blob = await openAsBlob(input, { type: contentType });
    if (blob.size !== size) throw nativeError('NATIVE_FILE_CHANGED', 'The file changed while it was read.', 'Retry once the file is stable.');
    // Integrity fields precede the file part: the server only reads fields sent before it.
    const form = new FormData();
    form.append('sizeBytes', String(size));
    form.append('checksum', checksum);
    form.append('file', blob, path.basename(input));
    return json(c, `${run()}/files`, 'POST', undefined, form);
  }
  // download: verify against the file row's checksum before the destination appears.
  const output = required(a, 'out');
  if (existsSync(output)) throw nativeError('NATIVE_DESTINATION_EXISTS', 'Download destination already exists.', 'Choose a new output path; existing local data was retained.');
  const id = fileId(a);
  const meta = record((await json(c, `${run()}/files/${id}`)).file);
  if (typeof meta.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(meta.checksum)) throw invalidResponse();
  const response = await call(c, `${run()}/files/${id}/download`);
  if (!response.body) throw invalidResponse();
  const temp = path.join(path.dirname(output), `.ml-dash-download-${process.pid}-${Date.now()}`);
  const handle = await open(temp, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { hash.update(chunk); bytes += chunk.length; await handle.write(chunk); }
    await handle.close();
    if (hash.digest('hex') !== meta.checksum.toLowerCase())
      throw nativeError('NATIVE_CHECKSUM_MISMATCH', 'Downloaded bytes failed SHA-256 verification.', 'Retry the download; the destination was not changed.');
    linkSync(temp, output);
  } finally {
    await handle.close().catch(() => {});
    try { unlinkSync(temp); } catch { /* already gone */ }
  }
  return { fileId: id, path: output, sizeBytes: bytes, checksum: meta.checksum, verified: true };
}
