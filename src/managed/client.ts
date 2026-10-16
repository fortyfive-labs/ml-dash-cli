import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ParsedArgs } from '../cli/parser.js';

export class ManagementError extends Error {
  constructor(readonly code: string, message: string, readonly remediation: string, readonly retryable = false) { super(message); }
}
export const invalidResponse = () => new ManagementError('MANAGED_INVALID_RESPONSE', 'The server returned an invalid response; no change was confirmed.', 'Check matching server versions and inspect status before retrying.');
export function record(v: unknown): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalidResponse();
  return v as Record<string, any>;
}
export function identity(value: unknown): Record<string,any> {
  const v=record(value);const user=v.user!==undefined?record(v.user):v;
  if(typeof user.id!=='string'&&typeof user.sub!=='string')throw new ManagementError('MANAGED_IDENTITY_UNVERIFIED','The server did not confirm the signed-in user.','Reauthenticate against the intended authority; cached token presence alone is not login verification.');
  return user;
}
export function text(v: unknown): string { if (typeof v !== 'string' || !v) throw invalidResponse(); return v; }
export function arg(a: ParsedArgs, k: string): string | undefined { return typeof a[k] === 'string' ? a[k] as string : undefined; }
export function required(a: ParsedArgs, k: string): string {
  const v = arg(a, k);
  if (!v) throw new ManagementError('MANAGED_ARGUMENT_REQUIRED', `--${k.replace(/_/g, '-')} is required.`, 'Inspect command help and supply the explicit target.');
  return v;
}
export function endpoint(raw: string): string {
  try {
    const u = new URL(raw);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname);
    if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) || u.username || u.password || u.search || u.hash) throw new Error();
    return u.toString().replace(/\/+$/, '');
  } catch { throw new ManagementError('MANAGED_INVALID_ENDPOINT', 'Use HTTPS, or HTTP on loopback, without credentials, query, or fragment.', 'Use the intended DreamLake login environment.'); }
}
function jsonFile(file: string): Record<string, any> {
  try { return record(JSON.parse(readFileSync(file, 'utf8'))); } catch { return {}; }
}
export interface Context { url: string; token?: string; dir: string; }
export function context(a: ParsedArgs, requireLogin = true): Context {
  const dir = process.env.ML_DASH_MANAGED_CONFIG_DIR || path.join(homedir(), '.dreamlake');
  const config = jsonFile(path.join(dir, 'config.json'));
  const configured = config.remote_url ? endpoint(config.remote_url) : 'https://api.dreamlake.ai';
  const url = endpoint(arg(a, 'dreamlake_url') || process.env.DREAMLAKE_REMOTE || configured);
  const envUrl = process.env.DREAMLAKE_REMOTE ? endpoint(process.env.DREAMLAKE_REMOTE) : configured;
  const override = process.env.DREAMLAKE_API_KEY;
  const token = override && url === envUrl ? override : url === configured ? jsonFile(path.join(dir, 'tokens.json'))['dreamlake-token'] : undefined;
  if (requireLogin && (typeof token !== 'string' || !token)) throw new ManagementError('MANAGED_LOGIN_REQUIRED', 'No DreamLake credential is available for the selected server.', 'Run ml-dash auth login for this DreamLake server, or use the existing DreamLake login.');
  return { url, token: typeof token === 'string' ? token : undefined, dir };
}
export function safe(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') return secrets.reduce((s, secret) => secret ? s.split(secret).join('[redacted]') : s, value);
  if (Array.isArray(value)) return value.map(v => safe(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => (k==='authorizationModes'||!/token|secret|password|authorization|privatekey|signedurl|downloadurl|s3url|database64/i.test(k))).map(([k,v]) => [k, safe(v, secrets)]));
  return value;
}
export async function request(c: Context, route: string, method = 'GET', body?: unknown): Promise<any> {
  let response: Response;
  try { response = await fetch(`${c.url}${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: {
    ...(c.token ? { authorization: `Bearer ${c.token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { throw new ManagementError('MANAGED_NETWORK_ERROR', 'Request failed; a write outcome may be unknown.', 'Inspect setup or run status before retrying the same idempotent request.', true); }
  if (!response.ok) {
    let code = `MANAGED_HTTP_${response.status}`;
    try { const b = await response.json() as any; const candidate = b?.error?.code ?? b?.code; if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(candidate)) code = candidate; } catch { /* Never print upstream body. */ }
    const advice = response.status === 401 ? 'Run ml-dash auth login for this environment.' : response.status === 403 ? 'Ask the organization or project owner for the required access, then retry discovery.' : response.status === 409 ? 'Read a fresh plan or status, review changed resources, and retry only the same idempotent intent.' : response.status === 404 ? 'Check the explicit target and matching managed backend capabilities.' : 'Check instance health and backend configuration; retry reads before any write.';
    throw new ManagementError(code, `The server rejected the request (HTTP ${response.status}).`, advice, response.status >= 500);
  }
  try {
    if(Number(response.headers.get('content-length'))>12*1024*1024)throw invalidResponse();
    if(!response.body)throw invalidResponse();
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let total=0;
    for(;;){const item=await reader.read();if(item.done)break;total+=item.value.length;if(total>12*1024*1024){await reader.cancel();throw invalidResponse();}chunks.push(item.value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw invalidResponse(); }
}
export function projectRoot(a: ParsedArgs): string { return `/managed-experiments/ns/${encodeURIComponent(required(a,'namespace'))}/projects/${encodeURIComponent(required(a,'project'))}`; }
export function query(a: ParsedArgs, keys = ['limit','cursor']): string {
  const q = new URLSearchParams();
  for (const k of keys) { const v = arg(a,k); if (v !== undefined) q.set(k,v); }
  const limit = arg(a,'limit');
  if (limit !== undefined && (!/^[1-9]\d*$/.test(limit) || Number(limit)>1000)) throw new ManagementError('MANAGED_INVALID_LIMIT', '--limit must be between 1 and 1000.', 'Choose a bounded page size.');
  return q.size ? `?${q}` : '';
}
export interface Session { token: string; expiresAt: number; projectId: string; instanceId: string; apiUrl: string; workloadId?: string; generation?: number; }
export async function session(c: Context, a: ParsedArgs, mode: 'read'|'write'|'delete'): Promise<Session> {
  const workloadId=arg(a,'credential'); const idempotencyKey=arg(a,'idempotency_key');
  if(mode!=='read'&&!workloadId&&(!idempotencyKey||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey))) throw new ManagementError('MANAGED_INTENT_REQUIRED','A first writer session requires a stable UUID --idempotency-key, or --credential for renewal.','Create one intent UUID, retain it across unknown outcomes, and inspect credentials before retrying.');
  const s = record(await request(c, `${projectRoot(a)}/session`, 'POST', { mode, ...(mode!=='read'&&arg(a,'run')?{runId:arg(a,'run')}:{}), ...(mode!=='read'?(workloadId?{workloadId}:{idempotencyKey}):{}) }));
  const apiUrl = endpoint(text(s.apiUrl));
  if(s.workloadId!==undefined&&(typeof s.workloadId!=='string'||!s.workloadId||!Number.isSafeInteger(s.generation)||s.generation<1))throw invalidResponse();
  if (typeof s.expiresAt !== 'number' || s.expiresAt <= Date.now()/1000 || s.expiresAt > Date.now()/1000+600 || !apiUrl.endsWith('/api/managed')) throw invalidResponse();
  return { token: text(s.token), expiresAt: s.expiresAt, projectId: text(s.projectId), instanceId: text(s.instanceId), apiUrl, ...(typeof s.workloadId==='string'?{workloadId:s.workloadId,generation:s.generation}:{}) };
}
export async function workload(c: Context, a: ParsedArgs, suffix: string, method = 'GET', body?: unknown): Promise<any> {
  const s = await session(c,a,method==='GET'?'read':method==='DELETE'?'delete':'write');
  try { const result=await request({ ...c, url:s.apiUrl, token:s.token }, `/projects/${encodeURIComponent(s.projectId)}${suffix}`, method, body);return safe({...record(result),...(s.workloadId?{workload:{id:s.workloadId,generation:s.generation,expiresAt:s.expiresAt}}:{})},[s.token,c.token || '']); }
  finally { s.token = ''; }
}

/** Fixed operations only: callers never accept user-supplied GraphQL text. HTTP200 errors fail closed. */
export async function graphql(c: Context, operation: string, variables: Record<string,unknown>): Promise<any> {
  const result=record(await request(c,'/graphql','POST',{query:operation,variables}));
  if(Array.isArray(result.errors)&&result.errors.length){
    const allow=new Set(['UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','BAD_USER_INPUT','OWNERSHIP_LIFECYCLE_UNSUPPORTED','ORGANIZATION_NOT_EMPTY','LAST_OWNER','LAST_OWNER_REQUIRED','CONFLICT']);
    const supplied=result.errors[0]?.extensions?.code;const code=typeof supplied==='string'&&allow.has(supplied)?supplied:'MANAGED_GRAPHQL_REJECTED';
    throw new ManagementError(code,'The typed organization operation was rejected.',code==='OWNERSHIP_LIFECYCLE_UNSUPPORTED'?'DreamLake organization deletion is intentionally disabled until resource and secret retention manifests exist; retain the organization.':'Check current organization ownership and membership; no successful change was confirmed.');
  }
  return record(result.data);
}
