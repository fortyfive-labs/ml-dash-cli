/**
 * The DreamLake shared login contract (v1), as documented by the DreamLake CLI
 * (docs: Environments → Shared login contract) and implemented there in
 * `src/cli/auth/{credentials,materialized}.ts`:
 *
 *   auth.yml      { current, envs: { <name>: { server, auth?, namespace, token } } }   saved environments
 *   tokens.json   { "dreamlake-token": <token> }                                       projection
 *   config.json   { remote_url, namespace, ... }                                       projection
 *
 * Login saves + projects; logout removes one environment and re-projects or
 * clears the projection only when it still holds that environment; with no
 * saved environment, logout clears an orphan projection. Other keys of
 * config.json (device_secret, the standalone ml-dash settings) are kept.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const TOKEN_SLOT = 'dreamlake-token';
export const BUILTIN_SERVERS: Record<string, string> = { prod: 'https://api.dreamlake.ai', staging: 'https://staging-api.dreamlake.ai' };

export interface EnvAuth { server: string; auth?: string; namespace: string; token: string }
interface AuthFile { current: string; envs: Record<string, EnvAuth> }

const trim = (url: string) => url.replace(/\/+$/, '');
function readJson(file: string): Record<string, unknown> {
  try { const v = JSON.parse(readFileSync(file, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
/** Atomic replace, chmod 600 (the DreamLake CLI's writer). */
function writeJson(file: string, data: Record<string, unknown>) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}
function load(dir: string): AuthFile {
  const file = path.join(dir, 'auth.yml');
  if (!existsSync(file)) return { current: '', envs: {} };
  try {
    const v = YAML.parse(readFileSync(file, 'utf8'));
    if (v?.envs && typeof v.envs === 'object') return { current: typeof v.current === 'string' ? v.current : Object.keys(v.envs)[0] ?? '', envs: v.envs };
    // The legacy flat shape is migrated by the DreamLake CLI; read it the same way.
    if (typeof v?.server === 'string' && typeof v?.token === 'string') {
      const name = Object.entries(BUILTIN_SERVERS).find(([, s]) => s === trim(v.server))?.[0] ?? 'default';
      return { current: name, envs: { [name]: { server: v.server, namespace: typeof v.namespace === 'string' ? v.namespace : '', token: v.token } } };
    }
  } catch { /* corrupt: treated as empty, as the DreamLake CLI does */ }
  return { current: '', envs: {} };
}
function save(dir: string, file: AuthFile) {
  const p = path.join(dir, 'auth.yml');
  if (!Object.keys(file.envs).length) { if (existsSync(p)) rmSync(p); return; }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(p, YAML.stringify({ current: file.current, envs: file.envs }), { mode: 0o600 });
  chmodSync(p, 0o600);
}
function project(dir: string, env: EnvAuth) {
  const tokens = readJson(path.join(dir, 'tokens.json'));
  tokens[TOKEN_SLOT] = env.token;
  writeJson(path.join(dir, 'tokens.json'), tokens);
  const config = readJson(path.join(dir, 'config.json'));
  config.remote_url = trim(env.server);
  if (env.namespace) config.namespace = env.namespace; else delete config.namespace;
  delete config.default_namespace;
  writeJson(path.join(dir, 'config.json'), config);
}
function clearProjection(dir: string) {
  const tokens = readJson(path.join(dir, 'tokens.json'));
  delete tokens[TOKEN_SLOT];
  writeJson(path.join(dir, 'tokens.json'), tokens);
  const config = readJson(path.join(dir, 'config.json'));
  for (const key of ['remote_url', 'namespace', 'default_namespace']) delete config[key];
  writeJson(path.join(dir, 'config.json'), config);
}

/** The environment name a login of `server` saves under: explicit, the built-in for it, the saved one for it, else `default`. */
export function envNameFor(dir: string, server: string, explicit?: string): string {
  if (explicit) return explicit;
  const builtin = Object.entries(BUILTIN_SERVERS).find(([, s]) => s === trim(server))?.[0];
  if (builtin) return builtin;
  return Object.entries(load(dir).envs).find(([, e]) => trim(e.server) === trim(server))?.[0] ?? 'default';
}

/** Login: save `env` as `name`, make it current, project it. Refuses to replace a same-named env of another server. */
export function saveLogin(dir: string, name: string, env: EnvAuth): void {
  const file = load(dir);
  const existing = file.envs[name];
  if (existing && trim(existing.server) !== trim(env.server))
    throw Object.assign(new Error(`Saved environment '${name}' belongs to ${existing.server}.`), { code: 'SHARED_LOGIN_ENV_CONFLICT' });
  file.envs[name] = env;
  file.current = name;
  save(dir, file);
  project(dir, env);
}

export type LogoutResult =
  | { status: 'logged-out'; env: string; projection: 'next' | 'cleared' | 'unchanged'; current: string | null }
  | { status: 'orphan-cleared'; server: string | null }
  | { status: 'not-logged-in' }
  | { status: 'unknown-env'; env: string; saved: string[] };

/** Logout of `name` (default: current), per contract v1. */
export function logout(dir: string, name?: string): LogoutResult {
  const file = load(dir);
  const projectedToken = readJson(path.join(dir, 'tokens.json'))[TOKEN_SLOT];
  const remote = readJson(path.join(dir, 'config.json')).remote_url;
  const projectedServer = typeof remote === 'string' ? trim(remote) : null;
  const target = name ?? (file.current && file.envs[file.current] ? file.current : '');
  if (!target) {
    if (typeof projectedToken === 'string' && projectedToken) { clearProjection(dir); return { status: 'orphan-cleared', server: projectedServer }; }
    return { status: 'not-logged-in' };
  }
  const removed = file.envs[target];
  if (!removed) return { status: 'unknown-env', env: target, saved: Object.keys(file.envs) };
  delete file.envs[target];
  if (file.current === target) file.current = Object.keys(file.envs)[0] ?? '';
  save(dir, file);
  if (projectedToken !== removed.token || projectedServer !== trim(removed.server))
    return { status: 'logged-out', env: target, projection: 'unchanged', current: file.current || null };
  const next = file.current ? file.envs[file.current] : undefined;
  if (next) project(dir, next); else clearProjection(dir);
  return { status: 'logged-out', env: target, projection: next ? 'next' : 'cleared', current: file.current || null };
}
