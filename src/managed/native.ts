/**
 * `--backend native`: the same runs/metrics/logs/files commands against DreamLake-native Experiments
 * (`/native-experiments/ns/:ns/projects/:project/...` on the DreamLake API), selected explicitly per
 * command. Uses the DreamLake login the managed mode already shares; never the standalone Dash login,
 * never a managed BFF or Dash proxy, and no fallback to another backend.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, linkSync, openAsBlob, readFileSync, statSync, unlinkSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { ParsedArgs } from '../cli/parser.js';
import { arg, invalidResponse, ManagementError, record, required, type Context } from './client.js';

/** Commands that have a native implementation, and the actions each supports there. */
export const nativeActions: Record<string, string[]> = {
  auth: ['status', 'login'], instance: ['show', 'capabilities', 'schema'], health: ['check'], diagnostics: ['check'],
  runs: ['list', 'show', 'create', 'status', 'parameters', 'delete', 'archive', 'unarchive', 'trash', 'restore', 'update', 'parameters-delete'],
  metrics: ['list', 'read', 'append', 'stats', 'metadata'], logs: ['read', 'append'],
  files: ['list', 'inspect', 'upload', 'download', 'update', 'delete'],
  orgs: ['list', 'members', 'teams', 'create', 'update', 'delete', 'member-add', 'member-role', 'member-remove'],
  teams: ['list', 'members'], projects: ['list', 'access'],
};
/** Actions only the native backend serves; the managed and standalone backends refuse them. */
export const nativeOnlyActions: Record<string, string[]> = {
  runs: ['archive', 'unarchive', 'trash', 'restore', 'update', 'parameters-delete'],
  metrics: ['stats', 'metadata'], files: ['update', 'delete'],
};
/** Why the remaining commands have no native form; reported instead of falling back. */
const unavailable: Record<string, string> = {
  setup: 'Native projects need no Dash setup; a DreamLake project with native Experiments is ready to use.',
  credentials: 'Native workload credentials are a pending backend dependency; native writes use your DreamLake login.',
  adoption: 'Adoption is a managed-backend operation; native mode performs no migration.',
  connections: 'External Dash connections belong to the managed backend only.',
  workspaces: 'Dash workspace binding belongs to the managed backend only.',
};
/** Managed-only review, credential and paging options that have no native meaning, except where a command keeps them. */
const managedOnly = ['apply', 'review', 'idempotency_key', 'credential', 'expected_generation', 'plan_hash', 'offset',
  'remote_project', 'remote_namespace', 'connection', 'expected_revision', 'standalone', 'dash_url'];
/** Organization commands run the same DreamLake GraphQL review/apply flow in both backends. */
const keptOptions: Record<string, string[]> = { orgs: ['apply', 'review', 'offset'] };

const RUN_ID = /^[0-9a-f]{24}$/;
const FILE_ID = /^[0-9a-f]{24}$/;
const METRIC = /^[A-Za-z0-9_.-]{1,128}$/;
const RESPONSE_LIMIT = 12 * 1024 * 1024;

export function nativeError(code: string, message: string, remediation: string, retryable = false) {
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
export async function call(c: Context, route: string, method = 'GET', body?: unknown, form?: FormData): Promise<Response> {
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
export async function json(c: Context, route: string, method = 'GET', body?: unknown, form?: FormData): Promise<Record<string, any>> {
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

/** Options added for native mode, and the native actions that actually send them. Anything else is refused, never ignored. */
const NATIVE_FLAGS = ['include_archived', 'level', 'start_time', 'end_time', 'search', 'order_by', 'order', 'prefix', 'tags', 'metadata'];
const flagUse: Record<string, string[]> = {
  'runs list': ['include_archived'], 'runs create': ['description', 'tags'], 'runs update': ['description', 'tags'],
  'metrics append': ['description', 'tags', 'metadata'], 'metrics metadata': ['description', 'tags', 'metadata'],
  'logs read': ['level', 'start_time', 'end_time', 'search', 'order_by', 'order'],
  'files list': ['prefix', 'tags'], 'files upload': ['prefix', 'description', 'tags', 'metadata'], 'files update': ['description', 'tags', 'metadata'],
  'orgs create': ['description'], 'orgs update': ['description'],
};
/**
 * Refuse a supplied option the selected action would not send. `--description` keeps its
 * pre-existing managed meaning (organization description) outside native mode.
 */
export function assertFlagUse(name: string, act: string, a: ParsedArgs, native: boolean) {
  const used = flagUse[`${name} ${act}`] ?? [];
  const given = (native ? [...NATIVE_FLAGS, 'description'] : NATIVE_FLAGS).filter(k => a[k] !== undefined && a[k] !== false);
  const ignored = given.find(k => !(native ? used : []).includes(k));
  if (ignored) throw nativeError(native ? 'NATIVE_OPTION_UNSUPPORTED' : 'MANAGED_OPTION_UNSUPPORTED',
    `--${ignored.replace(/_/g, '-')} is not used by ${name} ${act}${native ? ' on the native backend' : ' without --backend native'}.`,
    name === 'runs' && act === 'update' && ignored === 'metadata'
      ? 'Native runs accept --description and --tags; run metadata needs a backend contract that does not exist yet.'
      : 'Remove the option; it would otherwise be ignored.');
}

export function assertNativeSelection(name: string, act: string, a: ParsedArgs) {
  const reason = unavailable[name];
  if (reason || !nativeActions[name]?.includes(act))
    throw nativeError('NATIVE_NOT_AVAILABLE', `${name} ${act} has no native Experiments form.`, reason ?? 'Use one of the native actions listed in docs/MANAGED.md.');
  const bad = managedOnly.filter(k => a[k] !== undefined && a[k] !== false && !keptOptions[name]?.includes(k));
  if (bad.length) throw nativeError('NATIVE_OPTION_UNSUPPORTED', `--${bad[0]!.replace(/_/g, '-')} is a managed-backend option.`,
    'Native writes apply directly with your DreamLake login; remove the managed review, credential or paging options.');
  assertFlagUse(name, act, a, true);
}
/** The organization actions native mode serves through the shared managed GraphQL code (everything but list). */
export const sharedOrganizationAction = (name: string, act: string) => name === 'orgs' && act !== 'list';

async function graphqlData(c: Context, query: string, variables: Record<string, unknown> = {}) {
  const value = await json(c, '/graphql', 'POST', { query, variables });
  if (Array.isArray(value.errors) && value.errors.length) {
    const code = value.errors[0]?.extensions?.code;
    throw nativeError(typeof code === 'string' && /^[A-Z_]{2,60}$/.test(code) ? code : 'NATIVE_GRAPHQL_REJECTED', 'DreamLake rejected the query.', 'Check your organization or team membership.');
  }
  return record(value.data);
}
function noPaging(a: ParsedArgs, what: string) {
  if (arg(a, 'limit') !== undefined || arg(a, 'cursor') !== undefined || arg(a, 'offset') !== undefined)
    throw nativeError('NATIVE_PAGING_UNSUPPORTED', `DreamLake returns ${what} in one response; paging options are not accepted.`, 'Remove --limit, --cursor and --offset.');
}
function tagList(value: string) { return value.split(',').map(t => t.trim()).filter(Boolean); }
/** `--description` ("" clears), `--tags` ("" clears) and `--metadata <file|->` (object or null), if given. */
function describe(a: ParsedArgs, withMetadata = true): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (arg(a, 'description') !== undefined) out.description = arg(a, 'description') || null;
  if (arg(a, 'tags') !== undefined) out.tags = tagList(arg(a, 'tags')!);
  if (withMetadata && arg(a, 'metadata') !== undefined) {
    const value = load(arg(a, 'metadata')!);
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw nativeError('NATIVE_INVALID_METADATA', '--metadata must contain a JSON object or null.', 'Provide a JSON object.');
    out.metadata = value;
  }
  return out;
}
function patchOf(a: ParsedArgs, withMetadata = true) {
  const patch = describe(a, withMetadata);
  if (!Object.keys(patch).length) throw nativeError('NATIVE_ARGUMENT_REQUIRED', `Give --description${withMetadata ? ', --tags or --metadata' : ' or --tags'}.`, 'Supply the fields to change.');
  return patch;
}
function logFilters(a: ParsedArgs) {
  const q = new URLSearchParams();
  const level = arg(a, 'level');
  if (level !== undefined) {
    const levels = tagList(level);
    if (!levels.length || levels.some(l => !['info', 'warn', 'error', 'debug', 'fatal'].includes(l))) throw nativeError('NATIVE_INVALID_QUERY', '--level takes a comma list of info, warn, error, debug, fatal.', 'Choose valid levels.');
    q.set('level', levels.join(','));
  }
  for (const [key, dest] of [['startTime', 'start_time'], ['endTime', 'end_time']] as const) {
    const v = arg(a, dest);
    if (v !== undefined && !Number.isFinite(Date.parse(v))) throw nativeError('NATIVE_INVALID_QUERY', `--${dest.replace('_', '-')} must be an ISO timestamp.`, 'Use an ISO 8601 time.');
    if (v !== undefined) q.set(key, v);
  }
  const search = arg(a, 'search');
  if (search !== undefined) { if (!search.length || search.length > 1000) throw nativeError('NATIVE_INVALID_QUERY', '--search must be 1-1000 characters.', 'Shorten the search.'); q.set('search', search); }
  const orderBy = arg(a, 'order_by'), order = arg(a, 'order');
  if (orderBy !== undefined) { if (!['sequenceNumber', 'timestamp'].includes(orderBy)) throw nativeError('NATIVE_INVALID_QUERY', '--order-by must be sequenceNumber or timestamp.', 'Choose a valid field.'); q.set('orderBy', orderBy); }
  if (order !== undefined) { if (!['asc', 'desc'].includes(order)) throw nativeError('NATIVE_INVALID_QUERY', '--order must be asc or desc.', 'Choose asc or desc.'); q.set('order', order); }
  return q;
}

export async function nativeCommand(name: string, act: string, c: Context, a: ParsedArgs): Promise<unknown> {
  const base = () => `/native-experiments/ns/${encodeURIComponent(required(a, 'namespace'))}/projects/${encodeURIComponent(required(a, 'project'))}`;
  const run = () => `${base()}/runs/${runId(a)}`;
  if (name === 'orgs') {
    // list only: other organization actions run the shared managed GraphQL code (see commands.ts).
    noPaging(a, 'your organizations');
    return { organizations: (await graphqlData(c, 'query MlDashNativeOrganizations { myOrganizations { id slug name description myRole } }')).myOrganizations };
  }
  if (name === 'teams') {
    noPaging(a, act === 'list' ? 'your teams' : 'team members');
    if (act === 'list') return { teams: (await graphqlData(c, 'query MlDashNativeTeams { myTeams { id orgId slug name visibility myRole } }')).myTeams };
    return { teamId: required(a, 'team'), members: (await graphqlData(c, 'query MlDashNativeTeamMembers($teamId: ID!) { teamMembers(teamId: $teamId) { id userId role } }', { teamId: required(a, 'team') })).teamMembers };
  }
  if (name === 'projects') {
    if (act === 'access') return json(c, `${base()}/status`);
    // The DreamLake project catalog: only projects the caller can read, with per-project permissions.
    const q = new URLSearchParams();
    const limit = arg(a, 'limit'), cursor = arg(a, 'cursor');
    if (limit !== undefined) { if (!/^[1-9]\d*$/.test(limit) || Number(limit) > 200) throw nativeError('NATIVE_INVALID_LIMIT', '--limit must be between 1 and 200.', 'Choose a bounded page size.'); q.set('pageSize', limit); }
    if (cursor !== undefined) { if (!/^[1-9]\d*$/.test(cursor)) throw nativeError('NATIVE_INVALID_CURSOR', '--cursor is the page number (1, 2, ...) of the DreamLake project catalog.', 'Pass the next page number.'); q.set('page', cursor); }
    return json(c, `/namespaces/${encodeURIComponent(required(a, 'namespace'))}/projects${q.size ? `?${q}` : ''}`);
  }
  if (name === 'auth') {
    const me = record(await json(c, '/auth/me'));
    return { authenticated: true, server: c.url, backend: 'native', user: me.user ?? me, credentialSource: 'DreamLake shared login' };
  }
  if (name === 'instance' || name === 'health' || name === 'diagnostics') {
    const status = await json(c, `${base()}/status`);
    if (name === 'instance' && act === 'schema') {
      // Native Experiments publish capability names, not a machine operation schema; both are reported as such.
      const { cliInspectionSchema } = await import('../cli/schema.js');
      return { cli: await cliInspectionSchema(), server: { kind: 'native-experiments-status', operationSchema: null, ...status } };
    }
    return name === 'instance' ? status : { status: status.status, backend: 'native', server: c.url, project: status };
  }
  if (name === 'runs') {
    if (act === 'list') {
      const q = page(a, 100, RUN_ID);
      return json(c, `${base()}/runs${q}${a.include_archived ? `${q ? '&' : '?'}includeArchived=true` : ''}`);
    }
    if (act === 'trash') return json(c, `${base()}/trash${page(a, 100, RUN_ID)}`);
    if (act === 'archive' || act === 'unarchive') return json(c, run(), 'PATCH', { archived: act === 'archive' });
    if (act === 'restore') return json(c, `${run()}/restore`, 'POST');
    if (act === 'update') return json(c, run(), 'PATCH', patchOf(a, false));
    if (act === 'parameters-delete') return json(c, `${run()}/parameters`, 'DELETE');
    if (act === 'show') return json(c, run());
    if (act === 'create') {
      const key = required(a, 'run_key');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw nativeError('NATIVE_INVALID_RUN_KEY', 'Run key must contain 1-128 letters, numbers, underscores or hyphens.', 'Choose a stable idempotent run key.');
      // PUT carries the run's human metadata; repeating it with the same values changes nothing.
      return json(c, `${base()}/runs/${encodeURIComponent(key)}`, 'PUT', describe(a, false));
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
    if (act === 'stats') return json(c, `${run()}/metrics/${encodeURIComponent(metric(a))}/stats`);
    if (act === 'metadata') return json(c, `${run()}/metrics/${encodeURIComponent(metric(a))}`, 'PATCH', patchOf(a));
    const points = load(required(a, 'data'));
    if (!Array.isArray(points) || !points.length || points.length > 1000 || points.some(p => !p || typeof p !== 'object' || Array.isArray(p)))
      throw nativeError('NATIVE_INVALID_METRICS', 'Metric data must be a JSON array of 1-1000 objects.', 'Provide a bounded JSON array.');
    // The descriptor is stored with the points only when this append creates the metric.
    const descriptor = describe(a);
    return json(c, `${run()}/metrics/${encodeURIComponent(metric(a))}`, 'POST', { dataPoints: points, ...descriptor });
  }
  if (name === 'logs') {
    if (act === 'read') {
      const q = new URLSearchParams(page(a, 1000, /^(0|[1-9]\d*)$/).slice(1));
      for (const [k, v] of logFilters(a)) q.set(k, v);
      return json(c, `${run()}/logs${q.size ? `?${q}` : ''}`);
    }
    const entries = load(required(a, 'data'));
    if (!Array.isArray(entries) || !entries.length || entries.length > 1000) throw nativeError('NATIVE_INVALID_LOGS', 'Logs must contain 1-1000 entries.', 'Provide a bounded JSON array.');
    return json(c, `${run()}/logs`, 'POST', { entries });
  }
  // files
  if (act === 'list') {
    const q = new URLSearchParams();
    if (arg(a, 'prefix') !== undefined) q.set('prefix', arg(a, 'prefix')!);
    if (arg(a, 'tags') !== undefined) q.set('tags', tagList(arg(a, 'tags')!).join(','));
    return json(c, `${run()}/files${q.size ? `?${q}` : ''}`);
  }
  if (act === 'update') return json(c, `${run()}/files/${fileId(a)}`, 'PATCH', patchOf(a));
  if (act === 'delete') return json(c, `${run()}/files/${fileId(a)}`, 'DELETE');
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
    const extra = describe(a);
    if (arg(a, 'prefix') !== undefined) form.append('prefix', arg(a, 'prefix')!);
    if (typeof extra.description === 'string') form.append('description', extra.description);
    if (Array.isArray(extra.tags) && extra.tags.length) form.append('tags', extra.tags.join(','));
    if (extra.metadata) form.append('metadata', JSON.stringify(extra.metadata));
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
  // Bytes land in a private temp file beside the destination; only verified bytes are linked into place.
  const temp = path.join(path.dirname(output), `.ml-dash-download-${process.pid}-${randomUUID()}`);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(Readable.fromWeb(response.body as any),
      new Transform({ transform(chunk: Buffer, _e, done) { hash.update(chunk); bytes += chunk.length; done(null, chunk); } }),
      createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    if (hash.digest('hex') !== meta.checksum.toLowerCase() || statSync(temp).size !== bytes ||
        typeof meta.sizeBytes === 'number' && meta.sizeBytes !== bytes)
      throw nativeError('NATIVE_CHECKSUM_MISMATCH', 'Downloaded bytes failed size or SHA-256 verification.', 'Retry the download; the destination was not changed.');
    // link() fails when the destination exists, so a concurrent file is never replaced.
    try { linkSync(temp, output); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw nativeError('NATIVE_DESTINATION_EXISTS', 'Download destination already exists.', 'Choose a new output path; existing local data was retained.');
      throw e;
    }
  } finally {
    try { unlinkSync(temp); } catch { /* not created or already gone */ }
  }
  return { fileId: id, path: output, sizeBytes: bytes, checksum: meta.checksum, verified: true };
}
