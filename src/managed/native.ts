/**
 * `--backend native`: the same runs/metrics/logs/files commands against DreamLake-native Experiments
 * (`/native-experiments/ns/:ns/projects/:project/...` on the DreamLake API), selected explicitly per
 * command. Uses the DreamLake login the managed mode already shares; never the standalone Dash login,
 * never a managed BFF or Dash proxy, and no fallback to another backend.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, linkSync, openAsBlob, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { ParsedArgs } from '../cli/parser.js';
import { arg, invalidResponse, ManagementError, record, required, type Context } from './client.js';

const FOLDER_ACTIONS = ['list', 'show', 'create', 'update', 'trash', 'restore', 'protect', 'unprotect', 'purge', 'operation'];
/** Commands that have a native implementation, and the actions each supports there. */
export const nativeActions: Record<string, string[]> = {
  auth: ['status', 'login'], instance: ['show', 'capabilities', 'schema'], health: ['check'], diagnostics: ['check'],
  runs: ['list', 'show', 'create', 'status', 'parameters', 'delete', 'archive', 'unarchive', 'trash', 'restore', 'update', 'parameters-delete',
    'protect', 'unprotect', 'move', 'purge'],
  metrics: ['list', 'read', 'append', 'stats', 'metadata'], logs: ['read', 'append'],
  files: ['list', 'inspect', 'upload', 'download', 'update', 'delete'],
  orgs: ['list', 'members', 'teams', 'create', 'update', 'delete', 'member-add', 'member-role', 'member-remove'],
  teams: ['list', 'members', 'delete'], projects: ['list', 'access'],
  credentials: ['list', 'inspect', 'create', 'rotate', 'retire'],
  folders: FOLDER_ACTIONS, batch: ['trash', 'purge'],
};
/** Actions only the native backend serves; the managed and standalone backends refuse them. */
export const nativeOnlyActions: Record<string, string[]> = {
  runs: ['archive', 'unarchive', 'trash', 'restore', 'update', 'parameters-delete', 'protect', 'unprotect', 'move', 'purge'],
  metrics: ['stats', 'metadata'], files: ['update', 'delete'], teams: ['delete'],
  folders: FOLDER_ACTIONS, batch: ['trash', 'purge'],
};
/** Why the remaining commands have no native form; reported instead of falling back. */
const unavailable: Record<string, string> = {
  setup: 'Native projects need no Dash setup; a DreamLake project with native Experiments is ready to use.',
  adoption: 'Adoption is a managed-backend operation; native mode performs no migration.',
  connections: 'External Dash connections belong to the managed backend only.',
  workspaces: 'Dash workspace binding belongs to the managed backend only.',
};
/** Managed-only review, credential and paging options that have no native meaning, except where a command keeps them. */
const managedOnly = ['apply', 'review', 'idempotency_key', 'credential', 'expected_generation', 'plan_hash', 'offset',
  'remote_project', 'remote_namespace', 'connection', 'expected_revision', 'standalone', 'dash_url'];
/** Organization commands run the same DreamLake GraphQL review/apply flow in both backends. */
const keptOptions: Record<string, string[]> = { orgs: ['apply', 'review', 'offset'], teams: ['apply', 'review'],
  credentials: ['apply', 'review', 'idempotency_key', 'credential', 'expected_generation'] };

const RUN_ID = /^[0-9a-f]{24}$/;
const FILE_ID = /^[0-9a-f]{24}$/;
/**
 * A native metric name, as the server takes it (dreamlake-server `isMetricName`, ml-dash's rule): one URL path
 * segment of 1-256 characters (code points) without `/`, other than `.`/`..`. Unicode and spaces are names like any
 * other; it is sent percent-encoded.
 */
export const isNativeMetricName = (v: string) => v.length > 0 && !v.includes('/') && v !== '.' && v !== '..' && [...v].length <= 256;
/**
 * A native metric or log append, as the server takes it: up to 1,000 entries at any size, or more when they
 * serialize to at most 1 MiB (ml-dash-server's request bound). Larger is refused before any request.
 */
export const nativeBatchOk = (entries: unknown[]) =>
  entries.length <= 1000 || Buffer.byteLength(JSON.stringify(entries)) <= 1024 * 1024;
const BATCH_RULE = 'up to 1000 of any size, or more when they serialize to at most 1 MiB';
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
  if (!isNativeMetricName(v)) throw nativeError('NATIVE_INVALID_METRIC', 'Metric name must be 1-256 characters without "/", and not "." or "..".', 'Choose a valid metric name.');
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
const NATIVE_FLAGS = ['include_archived', 'level', 'start_time', 'end_time', 'search', 'order_by', 'order', 'prefix', 'tags', 'metadata',
  'write_protected', 'folder', 'folder_path', 'parent', 'path', 'operation', 'wait', 'runs', 'folders'];
const flagUse: Record<string, string[]> = {
  'runs list': ['include_archived'], 'runs create': ['description', 'tags', 'metadata', 'write_protected', 'folder_path'],
  'runs update': ['description', 'tags', 'metadata'], 'runs move': ['name', 'folder', 'folder_path'],
  'folders list': ['parent'], 'folders show': ['folder', 'path'], 'folders create': ['path', 'name', 'parent'],
  'folders update': ['folder', 'name', 'parent'], 'folders trash': ['folder', 'wait'], 'folders restore': ['folder', 'wait'],
  'folders protect': ['folder', 'wait'], 'folders unprotect': ['folder', 'wait'], 'folders purge': ['folder', 'wait'],
  'folders operation': ['operation', 'wait'], 'batch trash': ['runs', 'folders'], 'batch purge': ['runs', 'folders'],
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
  // `--description` and `--name` keep their organization meaning outside the native run and folder actions.
  const scoped = native && (name === 'runs' || name === 'folders' || name === 'batch') ? ['description', 'name'] : native ? ['description'] : [];
  const given = [...NATIVE_FLAGS, ...scoped].filter(k => a[k] !== undefined && a[k] !== false);
  const ignored = given.find(k => !(native ? used : []).includes(k));
  if (ignored) throw nativeError(native ? 'NATIVE_OPTION_UNSUPPORTED' : 'MANAGED_OPTION_UNSUPPORTED',
    `--${ignored.replace(/_/g, '-')} is not used by ${name} ${act}${native ? ' on the native backend' : ' without --backend native'}.`,
    'Remove the option; it would otherwise be ignored.');
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
/** A native folder or run name (WP4a `validName`): Unicode, at most 255 code points, no '/', control characters, '.' or '..'. */
export const validName = (name: string) => name.length > 0 && [...name].length <= 255 && !name.includes('/') &&
  !/[\u0000-\u001f\u007f]/.test(name) && name !== '.' && name !== '..' && name.trim().length > 0;
/** A folder path `a/b/c` (leading and trailing '/' ignored) as its validated segments. */
function pathOf(value: string, flag: string) {
  const segments = value.replace(/^\/+|\/+$/g, '').split('/');
  if (!value.replace(/\//g, '') || !segments.every(validName))
    throw nativeError('NATIVE_INVALID_PATH', `${flag} must be a folder path a/b/c of valid names.`, 'Names are 1-255 characters without control characters, and not "." or "..".');
  return segments;
}
const folderIdOf = (value: string, flag: string) => {
  if (!/^[0-9a-f]{24}$/.test(value)) throw nativeError('NATIVE_INVALID_FOLDER', `${flag} must be a native folder ID.`, 'Use an id from folders list or folders show.');
  return value;
};
/** `runs move`: a new `--name` and/or a destination (`--folder ID`, `--folder-path a/b`, or `root` for the project root). */
function moveOf(a: ParsedArgs) {
  const body: Record<string, unknown> = {};
  const name = arg(a, 'name'), folder = arg(a, 'folder'), folderPath = arg(a, 'folder_path');
  if (name !== undefined) {
    if (!validName(name)) throw nativeError('NATIVE_INVALID_RUN', '--name must be 1-255 characters without "/" or control characters.', 'Choose a valid run name.');
    body.name = name;
  }
  if (folder !== undefined && folderPath !== undefined) throw nativeError('NATIVE_ARGUMENT_CONFLICT', 'Give --folder or --folder-path, not both.', 'Choose one destination.');
  if (folder !== undefined) body.folderId = folder === 'root' ? null : folderIdOf(folder, '--folder');
  if (folderPath !== undefined) body.folderPath = folderPath === 'root' ? '' : pathOf(folderPath, '--folder-path').join('/');
  if (!Object.keys(body).length) throw nativeError('NATIVE_ARGUMENT_REQUIRED', 'Give --name, --folder or --folder-path.', 'Supply the new name or destination.');
  return body;
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
  if (name === 'teams' && act === 'delete') return teamDelete(c, a);
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
  if (name === 'credentials') return credentialsCommand(c, act, a, base());
  if (name === 'folders') return foldersCommand(c, act, a, base());
  if (name === 'batch') return batchCommand(c, act, a, base());
  if (name === 'auth') {
    const me = record(await json(c, '/auth/me'));
    return { authenticated: true, server: c.url, backend: 'native', user: me.user ?? me, credentialSource: 'DreamLake shared login' };
  }
  if (name === 'instance' || name === 'health' || name === 'diagnostics') {
    const status = await json(c, `${base()}/status`);
    if (name === 'instance' && act === 'schema') {
      const { cliInspectionSchema } = await import('../cli/schema.js');
      if (Array.isArray(status.capabilities) && status.capabilities.includes('machine-schema')) {
        // The server's machine contract (protocol native-1, distinct from managed protocol 1).
        const server = await json(c, '/native-experiments/schema?version=1');
        if (server.schemaVersion !== '1' || server.protocolVersion !== 'native-1' || !Array.isArray(server.operations) || !server.operations.length)
          throw nativeError('NATIVE_SCHEMA_UNSUPPORTED', 'The native schema version is not one this CLI reads.', 'Use matching CLI and server versions.');
        return { cli: await cliInspectionSchema(), server };
      }
      // An older server publishes capability names only; no operation schema is invented for it.
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
    if (act === 'update') return json(c, run(), 'PATCH', patchOf(a));
    // A person's protection (ml-dash `writeProtected`): set and cleared with WRITE; a workload or job session gets 403.
    if (act === 'protect' || act === 'unprotect') return json(c, run(), 'PATCH', { writeProtected: act === 'protect' });
    if (act === 'move') return json(c, run(), 'PATCH', moveOf(a));
    // ADMIN, a trashed run only: accepted at once (202), the data deleted afterwards. Never restorable.
    if (act === 'purge') return json(c, `${run()}/purge`, 'POST');
    if (act === 'parameters-delete') return json(c, `${run()}/parameters`, 'DELETE');
    if (act === 'show') return json(c, run());
    if (act === 'create') {
      const key = required(a, 'run_key');
      const folders = arg(a, 'folder_path') !== undefined ? pathOf(arg(a, 'folder_path')!, '--folder-path') : null;
      if (folders ? !validName(key) : !/^[A-Za-z0-9_-]{1,128}$/.test(key))
        throw nativeError('NATIVE_INVALID_RUN_KEY', folders ? 'A run name in a folder is 1-255 characters without "/" or control characters, and not "." or "..".'
          : 'Run key must contain 1-128 letters, numbers, underscores or hyphens.', 'Choose a stable idempotent run key.');
      // PUT carries the run's human metadata, its metadata dict and a person's protection, all written with the run
      // in one transaction; repeating it with the same values changes nothing, and it never unprotects.
      const body = { ...describe(a), ...(a.write_protected ? { writeProtected: true } : {}) };
      return json(c, folders ? `${base()}/run-paths/${[...folders, key].map(encodeURIComponent).join('/')}` : `${base()}/runs/${encodeURIComponent(key)}`, 'PUT', body);
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
    if (!Array.isArray(points) || !points.length || !nativeBatchOk(points) || points.some(p => !p || typeof p !== 'object' || Array.isArray(p)))
      throw nativeError('NATIVE_INVALID_METRICS', `Metric data must be a non-empty JSON array of objects: ${BATCH_RULE}.`, 'Split the data into smaller appends.');
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
    if (!Array.isArray(entries) || !entries.length || !nativeBatchOk(entries)) throw nativeError('NATIVE_INVALID_LOGS', `Logs must be a non-empty JSON array: ${BATCH_RULE}.`, 'Split the logs into smaller appends.');
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

// ── workload credentials ────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * `credentials list|inspect|create|rotate|retire --backend native`: the requester's own native
 * workload credentials (metadata only; no secret ever reaches the CLI). Changes keep the managed
 * grammar: a preview by default (`--out` saves it), then `--apply --review <saved>` applies exactly
 * that reviewed intent. The receipt binds server, namespace, project id and intent, and for rotate
 * and retire the credential's current generation, so a changed target refuses instead of applying.
 */
async function credentialsCommand(c: Context, act: string, a: ParsedArgs, base: string): Promise<unknown> {
  const status = await json(c, `${base}/status`);
  if (!Array.isArray(status.capabilities) || !status.capabilities.includes('workload-credentials'))
    throw nativeError('NATIVE_NOT_AVAILABLE', 'This DreamLake server has no native workload credentials.', 'Use a server that advertises workload-credentials.');
  if (act === 'list') return json(c, `${base}/credentials${page(a, 100, UUID)}`);
  const credentialId = () => {
    const id = required(a, 'credential').toLowerCase();
    if (!UUID.test(id)) throw nativeError('NATIVE_INVALID_CREDENTIAL', '--credential must be a credential id (UUID).', 'Use an id from credentials list.');
    return id;
  };
  if (act === 'inspect') return json(c, `${base}/credentials/${credentialId()}`);
  let intent: Record<string, unknown>;
  let current: Record<string, unknown> | null = null;
  if (act === 'create') {
    const key = required(a, 'idempotency_key').toLowerCase();
    if (!UUID.test(key)) throw nativeError('NATIVE_INVALID_INTENT', 'Credential creation requires a stable UUID --idempotency-key.', 'Create one intent UUID and reuse it across retries.');
    intent = { operation: 'create', idempotencyKey: key, ...(arg(a, 'run') !== undefined ? { runId: runId(a) } : {}) };
  } else {
    const generation = required(a, 'expected_generation');
    if (!/^[1-9]\d*$/.test(generation) || !Number.isSafeInteger(Number(generation)))
      throw nativeError('NATIVE_INVALID_GENERATION', '--expected-generation must be a positive integer.', 'Inspect the credential for its current generation.');
    intent = { operation: act, credentialId: credentialId(), expectedGeneration: Number(generation) };
    const found = record((await json(c, `${base}/credentials/${intent.credentialId}`)).credential);
    current = { generation: found.generation, active: found.active, runId: found.runId ?? null };
  }
  const review = { kind: 'native-workload-review-v1', server: c.url, namespace: required(a, 'namespace'), project: required(a, 'project'),
    namespaceId: status.namespaceId, projectId: status.projectId, intent, ...(current ? { current } : {}),
    intentHash: createHash('sha256').update(JSON.stringify(intent)).digest('hex') };
  if (!a.apply) {
    const out = arg(a, 'out');
    if (out) writeFileSync(out, JSON.stringify(review, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return { status: 'preview', review, remediation: 'Review it, then repeat with --apply --review <saved-file>.' };
  }
  let saved: unknown;
  try { saved = JSON.parse(readFileSync(required(a, 'review'), 'utf8')); }
  catch { throw nativeError('NATIVE_INVALID_REVIEW', 'The --review file is not a saved native credential review.', 'Save a preview with --out and review it first.'); }
  if (JSON.stringify(saved) !== JSON.stringify(review))
    throw nativeError('NATIVE_REVIEW_CHANGED', 'The credential, project or intent changed since the review.', 'Create and review a fresh preview; nothing was changed.');
  return json(c, `${base}/credentials`, 'POST', intent);
}

// ── folders, folder operations and batches (dreamlake-server protocol 6) ─────────

const OPERATION_ID = /^[0-9a-f]{24}$/;
const OPEN_OPERATION = ['checking', 'applying'];
/** How long `--wait` follows an accepted folder operation before handing back its id. */
const WAIT_MS = 10 * 60 * 1000;

/** Follow a folder operation until it is `done` or `refused`, or the wait ends (then its current state is returned). */
async function followOperation(c: Context, base: string, id: string, deadline = Date.now() + WAIT_MS) {
  for (let delay = 250; ; delay = Math.min(delay * 2, 5000)) {
    const value = await json(c, `${base}/folder-operations/${id}`);
    const operation = record(value.operation);
    if (!OPEN_OPERATION.includes(String(operation.state)) || Date.now() + delay > deadline) return value;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

/**
 * `folders list|show|create|update|trash|restore|protect|unprotect|purge|operation --backend native`: a project's
 * native folders (servers with the run lifecycle). trash/restore/protect/unprotect/purge are accepted at once (202
 * `{ operationId, state }`) and applied to every run below by the server; `operation --operation ID` reads its state
 * and counts, and `--wait` follows it to `done` or `refused`. A purge (ADMIN, a trashed folder) deletes nothing until
 * every run below was found unprotected. People only: a workload or job session is refused by the server.
 */
async function foldersCommand(c: Context, act: string, a: ParsedArgs, base: string): Promise<unknown> {
  if (act === 'operation') {
    const id = required(a, 'operation');
    if (!OPERATION_ID.test(id)) throw nativeError('NATIVE_INVALID_OPERATION', '--operation must be a folder operation ID.', 'Use the operationId a folder change returned.');
    return a.wait ? followOperation(c, base, id) : json(c, `${base}/folder-operations/${id}`);
  }
  if (act === 'list') {
    const q = new URLSearchParams(page(a, 200, RUN_ID).slice(1));
    if (arg(a, 'parent') !== undefined && arg(a, 'parent') !== 'root') q.set('parentId', folderIdOf(arg(a, 'parent')!, '--parent'));
    return json(c, `${base}/folders${q.size ? `?${q}` : ''}`);
  }
  if (act === 'show') {
    if (arg(a, 'folder') !== undefined && arg(a, 'path') !== undefined) throw nativeError('NATIVE_ARGUMENT_CONFLICT', 'Give --folder or --path, not both.', 'Choose one.');
    // By path: the folder or the run there (`{ kind, folder | experiment }`).
    if (arg(a, 'path') !== undefined) return json(c, `${base}/by-path/${pathOf(arg(a, 'path')!, '--path').map(encodeURIComponent).join('/')}`);
    return json(c, `${base}/folders/${folderIdOf(required(a, 'folder'), '--folder')}`);
  }
  if (act === 'create') {
    if (arg(a, 'path') !== undefined) {
      if (arg(a, 'name') !== undefined || arg(a, 'parent') !== undefined) throw nativeError('NATIVE_ARGUMENT_CONFLICT', 'Give --path, or --name with an optional --parent.', 'Choose one form.');
      return json(c, `${base}/folders`, 'POST', { path: pathOf(arg(a, 'path')!, '--path').join('/') });
    }
    const name = required(a, 'name');
    if (!validName(name)) throw nativeError('NATIVE_INVALID_FOLDER', '--name must be 1-255 characters without "/" or control characters.', 'Choose a valid folder name.');
    const parent = arg(a, 'parent');
    return json(c, `${base}/folders`, 'POST', { name, ...(parent !== undefined && parent !== 'root' ? { parentId: folderIdOf(parent, '--parent') } : {}) });
  }
  const folder = folderIdOf(required(a, 'folder'), '--folder');
  if (act === 'update') {
    const body: Record<string, unknown> = {};
    if (arg(a, 'name') !== undefined) {
      if (!validName(arg(a, 'name')!)) throw nativeError('NATIVE_INVALID_FOLDER', '--name must be 1-255 characters without "/" or control characters.', 'Choose a valid folder name.');
      body.name = arg(a, 'name');
    }
    if (arg(a, 'parent') !== undefined) body.parentId = arg(a, 'parent') === 'root' ? null : folderIdOf(arg(a, 'parent')!, '--parent');
    if (!Object.keys(body).length) throw nativeError('NATIVE_ARGUMENT_REQUIRED', 'Give --name and/or --parent (a folder ID, or root).', 'Supply the new name or parent.');
    return json(c, `${base}/folders/${folder}`, 'PATCH', body);
  }
  const accepted = await json(c, `${base}/folders/${folder}/${act}`, 'POST');
  if (typeof accepted.operationId !== 'string' || !OPERATION_ID.test(accepted.operationId)) throw invalidResponse();
  if (!a.wait) return { ...accepted, remediation: `Follow it with: folders operation --operation ${accepted.operationId} --wait` };
  return { operationId: accepted.operationId, ...(await followOperation(c, base, accepted.operationId)) };
}

/** `--runs a,b --folders c,d`: the items of a batch, as the server takes them (at most 100). */
function batchItems(a: ParsedArgs) {
  const items: Array<{ type: 'run' | 'folder'; id: string }> = [];
  for (const [type, dest] of [['run', 'runs'], ['folder', 'folders']] as const) {
    if (arg(a, dest) === undefined) continue;
    for (const id of tagList(arg(a, dest)!)) {
      if (!/^[0-9a-f]{24}$/.test(id)) throw nativeError('NATIVE_INVALID_BATCH', `--${dest} takes comma-separated native ${type} IDs.`, 'Use ids from runs list or folders list.');
      items.push({ type, id });
    }
  }
  if (!items.length || items.length > 100) throw nativeError('NATIVE_INVALID_BATCH', 'A batch takes 1-100 items from --runs and --folders.', 'Split larger selections into several batches.');
  return items;
}

/**
 * `batch trash|purge --runs … --folders …` (ml-dash `nodes/batch-delete`): each item on its own, never one atomic
 * batch. Runs change at once (`done`); folders are accepted operations (`accepted` with `operationId`); anything
 * refused is `skipped` with the server's reason. Any skipped item makes the command fail after printing every receipt.
 */
async function batchCommand(c: Context, act: string, a: ParsedArgs, base: string): Promise<unknown> {
  const value = await json(c, `${base}/batch/${act}`, 'POST', { items: batchItems(a) });
  const counts = record(value.counts);
  if (typeof counts.skipped !== 'number' || !Array.isArray(value.items)) throw invalidResponse();
  if (counts.skipped > 0) {
    const skipped = (value.items as any[]).filter(item => item?.status === 'skipped')
      .map(item => `${item.type} ${item.id}: ${/^[A-Z0-9_]{1,100}$/.test(String(item.reason)) ? item.reason : 'refused'}`);
    throw nativeError('NATIVE_BATCH_PARTIAL', `${counts.skipped} of ${value.items.length} items were skipped; the others were applied or accepted (done ${counts.done}, accepted ${counts.accepted}).`,
      `Skipped: ${skipped.join('; ')}. Fix those items and send them again.`);
  }
  return value;
}

// ── team deletion (DreamLake `teamDelete`, dreamlake-server #1710) ────────────────

const TEAM_DELETE_EFFECT = 'Delete this leaf team: its project grants, its references in pending invitations and its memberships are removed, and the team is kept as a tombstone whose slug stays reserved. Nothing is physically purged. Only an organization OWNER or a MAINTAINER of the team who is still an organization member may delete it; the server refuses a team with child teams, and one that still holds Vault secrets (including retired ones), active access keys, host credential bindings, a KMS boundary or migration, or a pending secret transfer.';

async function teamGraphql(c: Context, query: string, variables: Record<string, unknown>) {
  const value = await json(c, '/graphql', 'POST', { query, variables });
  if (Array.isArray(value.errors) && value.errors.length) {
    const supplied = value.errors[0]?.extensions?.code;
    const code = typeof supplied === 'string' && /^[A-Z_]{2,60}$/.test(supplied) ? supplied : 'NATIVE_GRAPHQL_REJECTED';
    // The server's precondition names what must be resolved first (child teams, Vault state); keep it.
    if (code === 'PRECONDITION_FAILED' && typeof value.errors[0]?.message === 'string')
      throw nativeError(code, 'DreamLake refused to delete the team.', value.errors[0].message.slice(0, 300));
    throw nativeError(code, 'DreamLake rejected the team operation.', code === 'FORBIDDEN'
      ? 'Only an organization owner or a maintainer of this team can delete it.' : 'Check the team ID and your organization membership; nothing was changed.');
  }
  return record(value.data);
}

/**
 * `teams delete --team ID --backend native`: a preview by default (`--out` saves it), then `--apply --review <saved>`
 * deletes exactly the reviewed team, as `orgs delete` does. The review binds the server, the actor and the team's
 * current state, so a changed team refuses instead of applying.
 */
async function teamDelete(c: Context, a: ParsedArgs): Promise<unknown> {
  const id = required(a, 'team');
  if (!/^[0-9a-f]{24}$/.test(id)) throw nativeError('NATIVE_INVALID_TEAM', '--team must be a DreamLake team ID.', 'Use an id from teams list or orgs teams.');
  const me = record(await json(c, '/auth/me'));
  const actorId = record(me.user ?? me).id;
  const found = (await teamGraphql(c, 'query MlDashNativeTeamReview($id: ID!) { team(id: $id) { id slug name orgId parentId myRole org { slug myRole } children { id } members { id } } }', { id })).team;
  if (!found) throw nativeError('NOT_FOUND', 'Team not found.', 'Check the team ID; a deleted team is not shown.');
  const t = record(found);
  const team = { id: t.id, slug: t.slug, name: t.name, orgId: t.orgId, organization: t.org?.slug ?? null, parentId: t.parentId ?? null,
    myOrganizationRole: t.org?.myRole ?? null, myTeamRole: t.myRole ?? null,
    childTeams: Array.isArray(t.children) ? t.children.length : null, members: Array.isArray(t.members) ? t.members.length : null };
  const review = { kind: 'team-delete-review-v1', server: c.url, actorId, team, effect: TEAM_DELETE_EFFECT };
  if (!a.apply) {
    const out = arg(a, 'out');
    if (out) writeFileSync(out, JSON.stringify(review, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return { status: 'preview', review, remediation: 'Review it, then repeat with --apply --review <saved-file>.' };
  }
  let saved: unknown;
  try { saved = JSON.parse(readFileSync(required(a, 'review'), 'utf8')); }
  catch { throw nativeError('NATIVE_INVALID_REVIEW', 'The --review file is not a saved team delete review.', 'Save a preview with --out and review it first.'); }
  if (JSON.stringify(saved) !== JSON.stringify(review))
    throw nativeError('NATIVE_REVIEW_CHANGED', 'The team, its members or your access changed since the review.', 'Create and review a fresh preview; nothing was changed.');
  const result = await teamGraphql(c, 'mutation MlDashNativeTeamDelete($id: ID!) { teamDelete(id: $id) }', { id });
  if (result.teamDelete !== true) throw invalidResponse();
  return { status: 'deleted', team: { id: team.id, slug: team.slug, organization: team.organization } };
}
