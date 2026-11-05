/**
 * `upload`, `download` and `list` with `--backend native`: tracks and local `.dash` transfer against
 * DreamLake-native Experiments, using the shared DreamLake login (managed `context`). The local format
 * is the existing LocalStorage tree. Only flat root runs (`.dash/<namespace>/<project>/<run>`) transfer:
 * nested folders need a native folder contract that does not exist yet, and are refused, never
 * flattened. No request falls back to a standalone Dash server.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, linkSync, mkdirSync, openAsBlob, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ParsedArgs } from '../cli/parser.js';
import { LocalStorage } from '../local/storage.js';
import { discoverExperiments } from '../commands/upload.js';
import { bold, cyan, green, red, yellow } from '../util/ansi.js';
import { context, ManagementError, type Context } from './client.js';
import { call, json, nativeError } from './native.js';

const RUN_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const PAGE_LIMIT = 100;
const runsBase = (ns: string, project: string) => `/native-experiments/ns/${encodeURIComponent(ns)}/projects/${encodeURIComponent(project)}`;

/** Options of the standalone grammar that native transfer does not implement; refused rather than ignored. */
function refuse(args: ParsedArgs, names: string[], why: string) {
  const given = names.find(k => args[k] !== undefined && args[k] !== false);
  if (given) throw nativeError('NATIVE_OPTION_UNSUPPORTED', `--${given.replace(/_/g, '-')} is not supported with --backend native.`, why);
}
function nativeContext(args: ParsedArgs): Context {
  refuse(args, ['dash_url'], 'Native mode uses the DreamLake login and server; remove --dash-url.');
  return context(args);
}
/** `ns/project/run/topic...` → parts; the run is exactly the third segment (no folders natively). */
function trackTarget(raw: string, minParts: number, usage: string) {
  const parts = raw.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < minParts || parts.some(p => !p)) throw nativeError('NATIVE_INVALID_PATH', `Path must be ${usage}.`, 'Native runs are addressed as namespace/project/run-key; nested folders are not available yet.');
  if (!RUN_KEY.test(parts[2]!)) throw nativeError('NATIVE_INVALID_RUN_KEY', `'${parts[2]}' is not a native run key.`, 'Run keys contain 1-128 letters, digits, underscores or hyphens.');
  return { namespace: parts[0]!, project: parts[1]!, key: parts[2]!, rest: parts.slice(3).join('/') };
}

/** Every visible run of a project (archived included), page by page, bounded. */
async function allRuns(c: Context, ns: string, project: string): Promise<any[]> {
  const runs: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const value: Record<string, any> = await json(c, `${runsBase(ns, project)}/runs?limit=100&includeArchived=true${cursor ? `&cursor=${cursor}` : ''}`);
    if (!Array.isArray(value.runs)) throw nativeError('NATIVE_INVALID_RESPONSE', 'Invalid run list.', 'Check matching server versions.');
    runs.push(...value.runs);
    if (!value.nextCursor) return runs;
    if (value.nextCursor === cursor) throw nativeError('NATIVE_CURSOR_LOOP', 'The server repeated a cursor.', 'Retry after the server paging issue is resolved.');
    cursor = value.nextCursor;
  }
  throw nativeError('NATIVE_PAGE_LIMIT', 'The project has more runs than one bounded scan reads.', 'Address the run by its ID with the runs/metrics/files commands.');
}
/** The run with this key, without creating one (the old CLI required an existing experiment). */
async function runByKey(c: Context, ns: string, project: string, key: string) {
  const found = (await allRuns(c, ns, project)).filter(run => run.name === key);
  if (found.length !== 1) throw nativeError('NATIVE_RUN_NOT_FOUND', `Run '${key}' was not found in ${ns}/${project}.`, 'Create it with ml-dash runs create --backend native, or check the key.');
  return found[0];
}

/** Stream a response into `output` through a sibling temp file; `replace` keeps the old CLI's overwrite. */
async function saveResponse(response: Response, output: string, replace: boolean) {
  if (!response.body) throw nativeError('NATIVE_INVALID_RESPONSE', 'Empty response body.', 'Retry the download.');
  const temp = path.join(path.dirname(output), `.ml-dash-download-${process.pid}-${randomUUID()}`);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(Readable.fromWeb(response.body as any),
      new Transform({ transform(chunk: Buffer, _e, done) { hash.update(chunk); bytes += chunk.length; done(null, chunk); } }),
      createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    if (statSync(temp).size !== bytes) throw nativeError('NATIVE_WRITE_INCOMPLETE', 'The download was not fully written.', 'Retry the download.');
    if (replace) renameSync(temp, output);
    else linkSync(temp, output);
  } finally {
    try { unlinkSync(temp); } catch { /* renamed or never created */ }
  }
  return { bytes, checksum: hash.digest('hex') };
}

// ── tracks ──────────────────────────────────────────────────────────────────

/** `upload --tracks FILE --remote-path ns/project/run/topic --backend native` */
export async function uploadTrackNative(args: ParsedArgs): Promise<number> {
  const c = nativeContext(args);
  const { readFileSync } = await import('node:fs');
  const t = trackTarget(String(args.remote_path ?? ''), 4, "'namespace/project/run-key/topic'");
  const local = String(args.tracks);
  if (!existsSync(local)) throw nativeError('NATIVE_FILE_UNREADABLE', `File not found: ${local}`, 'Choose a readable JSONL file.');
  const run = await runByKey(c, t.namespace, t.project, t.key);
  const entries: Record<string, unknown>[] = [];
  readFileSync(local, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.timestamp !== 'number') {
        console.log(`${yellow('Warning:')} Line ${i + 1} has no numeric timestamp, skipping`);
        return;
      }
      entries.push(entry);
    } catch (e) { console.log(`${yellow('Warning:')} Line ${i + 1} invalid JSON: ${(e as Error).message}`); }
  });
  if (!entries.length) throw nativeError('NATIVE_TRACK_EMPTY', 'No valid entries found in the file.', 'Each JSONL line needs a numeric timestamp.');
  console.log(bold('Uploading track data (native)...'));
  const route = `${runsBase(t.namespace, t.project)}/runs/${run.id}/tracks/${encodeURIComponent(t.rest)}/append_batch`;
  let total = 0;
  for (let i = 0; i < entries.length; i += 1000) {
    const batch = entries.slice(i, i + 1000);
    await json(c, route, 'POST', { entries: batch });
    total += batch.length;
    console.log(`  Uploaded ${total}/${entries.length} entries`);
  }
  console.log(`\n${green('✓ Track data uploaded successfully')}\n  Total entries: ${total}\n  Topic: ${t.rest}\n  Run: ${t.namespace}/${t.project}/${t.key} (${run.id})`);
  return 0;
}

/** `download --tracks ns/project/run/topic [--format F] [-o FILE] --backend native` */
export async function downloadTrackNative(args: ParsedArgs): Promise<number> {
  const c = nativeContext(args);
  const t = trackTarget(String(args.tracks), 4, "'namespace/project/run-key/topic'");
  const format = typeof args.format === 'string' ? args.format : 'jsonl';
  const run = await runByKey(c, t.namespace, t.project, t.key);
  const output = path.resolve(typeof args.output === 'string' ? args.output : `${t.rest.replace(/\//g, '_')}.${format}`);
  // A trailing '/' in the topic selects every track under it (mcap only), as the server documents.
  const topic = encodeURIComponent(t.rest + (String(args.tracks).endsWith('/') ? '/' : ''));
  const response = await call(c, `${runsBase(t.namespace, t.project)}/runs/${run.id}/tracks/${topic}/data?format=${encodeURIComponent(format)}`);
  const { bytes } = await saveResponse(response, output, true);
  console.log(`${green('✓ Track data downloaded successfully')}\n  Output: ${output}\n  Size: ${bytes} bytes\n  Format: ${format}`);
  return 0;
}

/** `list --tracks -p ns/project/run [--topic-filter T] --backend native` */
export async function listTracksNative(args: ParsedArgs): Promise<number> {
  const c = nativeContext(args);
  refuse(args, ['status', 'tags', 'detailed'], 'Native track listing takes --project and --topic-filter only.');
  const t = trackTarget(String(args.project ?? ''), 3, "'namespace/project/run-key'");
  if (t.rest) throw nativeError('NATIVE_INVALID_PATH', 'Track listing takes namespace/project/run-key.', 'Pass the topic with --topic-filter.');
  const run = await runByKey(c, t.namespace, t.project, t.key);
  const filter = typeof args.topic_filter === 'string' ? `?topic=${encodeURIComponent(args.topic_filter)}` : '';
  const { tracks } = await json(c, `${runsBase(t.namespace, t.project)}/runs/${run.id}/tracks${filter}`);
  if (!Array.isArray(tracks) || !tracks.length) { console.log(yellow('No tracks found')); return 0; }
  console.log(bold(`\nTracks in ${t.namespace}/${t.project}/${t.key}\n`));
  for (const track of tracks) console.log(`  ${cyan(String(track.topic))}  ${track.totalEntries ?? track.count ?? 0} entries`);
  return 0;
}

// ── local .dash transfer (flat root runs) ───────────────────────────────────

const UNSUPPORTED_TRANSFER = ['resume', 'state_file', 'strict', 'tracks', 'remote_path', 'experiment_path'];

/** `upload [PATH] --backend native [-p FILTER] [-t ns/project]` */
export async function uploadNative(args: ParsedArgs): Promise<number> {
  refuse(args, UNSUPPORTED_TRANSFER, 'Native upload has no resume state or strict mode yet; run it again after fixing the data.');
  const c = nativeContext(args);
  const storage = new LocalStorage(typeof args.path === 'string' ? args.path : './.dash');
  const found = discoverExperiments(storage, typeof args.project === 'string' ? args.project : undefined);
  if (!found.length) { console.log(yellow('No local experiments found.')); return 0; }
  const nested = found.filter(e => e.storagePrefix.split('/').length !== 3 || (e.declaredPrefix && e.declaredPrefix.replace(/^\/+|\/+$/g, '').split('/').length !== 3));
  if (nested.length) throw nativeError('NATIVE_FOLDERS_PENDING', `${nested.length} selected experiment(s) are inside folders (e.g. ${nested[0]!.storagePrefix}).`,
    'Native folders are not available yet; select flat runs with -p, or wait for the native folder contract. Nothing was uploaded.');
  let target: string[] | undefined;
  if (typeof args.target === 'string') {
    target = args.target.replace(/^\/+|\/+$/g, '').split('/');
    if (target.length !== 2 || target.some(p => !p)) throw nativeError('NATIVE_INVALID_PATH', '--target must be namespace/project.', 'Native runs live directly in a DreamLake project.');
  }
  const batch = Math.min(Math.max(Number(args.batch_size ?? 1000) || 1000, 1), 1000);
  for (const e of found) {
    const [ownerPart, projectPart, key] = e.storagePrefix.split('/') as [string, string, string];
    const [ns, project] = target ?? [ownerPart, projectPart];
    if (!RUN_KEY.test(key)) throw nativeError('NATIVE_INVALID_RUN_KEY', `Local experiment '${key}' is not a valid native run key.`, 'Rename it to letters, digits, underscores or hyphens.');
    const meta = storage.readExperiment(e.storagePrefix) ?? {};
    const params = args.skip_params ? null : storage.readParameters(e.storagePrefix);
    const metrics = args.skip_metrics ? [] : e.metrics;
    const logs = args.skip_logs ? [] : storage.readLogs(e.storagePrefix);
    const files = args.skip_files ? [] : storage.listFiles(e.storagePrefix);
    console.log(`${bold(`${e.storagePrefix}`)} → ${ns}/${project}/${key}: ${params ? 'params, ' : ''}${metrics.length} metrics, ${logs.length} logs, ${files.length} files`);
    if (args.dry_run) continue;
    const base = runsBase(ns, project);
    const runBody: Record<string, unknown> = {};
    if (typeof meta.description === 'string' && meta.description) runBody.description = meta.description;
    if (Array.isArray(meta.tags) && meta.tags.length) runBody.tags = meta.tags;
    const run = (await json(c, `${base}/runs/${encodeURIComponent(key)}`, 'PUT', runBody)).experiment;
    const r = `${base}/runs/${run.id}`;
    if (params && Object.keys(params).length) await json(c, `${r}/parameters`, 'POST', { data: params });
    for (const metric of metrics) {
      const { points, skipped } = storage.readMetricPoints(metric);
      if (skipped) console.log(`  ${yellow('Warning:')} ${metric.name}: ${skipped} unreadable point(s) skipped`);
      for (let i = 0; i < points.length; i += batch)
        await json(c, `${r}/metrics/${encodeURIComponent(metric.name)}`, 'POST', { dataPoints: points.slice(i, i + batch) });
    }
    const levels = ['info', 'warn', 'error', 'debug', 'fatal'];
    const entries = logs.filter(l => typeof l.message === 'string' && Number.isFinite(Date.parse(l.timestamp)))
      .map(l => ({ timestamp: l.timestamp, level: levels.includes(l.level) ? l.level : 'info', message: l.message, ...(l.metadata ? { metadata: l.metadata } : {}) }));
    if (entries.length !== logs.length) console.log(`  ${yellow('Warning:')} ${logs.length - entries.length} log line(s) without a valid timestamp skipped`);
    for (let i = 0; i < entries.length; i += batch) await json(c, `${r}/logs`, 'POST', { entries: entries.slice(i, i + batch) });
    for (const file of files) {
      const source = storage.filePath(e.storagePrefix, file);
      const blob = await openAsBlob(source, { type: file.contentType || 'application/octet-stream' });
      const hash = createHash('sha256');
      for await (const chunk of blob.stream() as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
      const form = new FormData();
      form.append('sizeBytes', String(blob.size));
      form.append('checksum', hash.digest('hex'));
      form.append('prefix', '/' + (file.path ?? '').replace(/^\/+/, ''));
      if (file.description) form.append('description', file.description);
      if (file.tags?.length) form.append('tags', file.tags.join(','));
      if (file.metadata) form.append('metadata', JSON.stringify(file.metadata));
      form.append('file', blob, file.filename);
      await json(c, `${r}/files`, 'POST', undefined, form);
    }
    console.log(`  ${green('✓')} run ${run.id}`);
  }
  return 0;
}

/** `download [PATH] --backend native -p ns/project [--experiment KEY]` */
export async function downloadNative(args: ParsedArgs): Promise<number> {
  refuse(args, [...UNSUPPORTED_TRANSFER, 'max_concurrent_metrics', 'max_concurrent_files'], 'Native download reads sequentially and has no resume state yet.');
  const c = nativeContext(args);
  const [ns, project, extra] = String(args.project ?? '').replace(/^\/+|\/+$/g, '').split('/');
  if (!ns || !project || extra !== undefined) throw nativeError('NATIVE_INVALID_PATH', '--project must be namespace/project.', 'Native runs live directly in a DreamLake project; globs and folders are not available.');
  const storage = new LocalStorage(typeof args.path === 'string' ? args.path : './.dash');
  const runs = (await allRuns(c, ns, project)).filter(run => typeof args.experiment !== 'string' || run.name === args.experiment);
  if (!runs.length) { console.log(yellow('No matching native runs.')); return 0; }
  const page = Math.min(Math.max(Number(args.batch_size ?? 1000) || 1000, 1), 1000);
  const base = runsBase(ns, project);
  for (const run of runs) {
    const prefix = `${ns}/${project}/${run.name}`;
    if (storage.readExperiment(prefix)) {
      if (!args.overwrite) { console.log(`${yellow('Skip')} ${prefix}: exists locally (use --overwrite)`); continue; }
      if (!args.dry_run) rmSync(storage.experimentDir(prefix), { recursive: true, force: true });
    }
    console.log(`${bold(prefix)} ← run ${run.id}`);
    if (args.dry_run) continue;
    const r = `${base}/runs/${run.id}`;
    storage.createExperiment({ project, prefix, description: run.description ?? null, tags: run.tags ?? [] });
    if (!args.skip_params) {
      try {
        const value = (await json(c, `${r}/parameters`)).parameters;
        const data = value && typeof value === 'object' && value.data && typeof value.data === 'object' ? value.data : value;
        if (data && typeof data === 'object' && Object.keys(data).length) storage.writeParameters(prefix, data);
      } catch (e) { if (!(e instanceof ManagementError && e.code === 'NATIVE_HTTP_404')) throw e; }
    }
    if (!args.skip_metrics) {
      for (const metric of (await json(c, `${r}/metrics`)).metrics ?? []) {
        for (let cursor: string | null = '0'; cursor !== null;) {
          const value: Record<string, any> = await json(c, `${r}/metrics/${encodeURIComponent(metric.name)}?limit=${page}&cursor=${cursor}`);
          if (value.rows?.length) storage.appendBatchToMetric(prefix, metric.name, value.rows);
          cursor = value.nextCursor ?? null;
        }
      }
    }
    if (!args.skip_logs) {
      for (let cursor: string | null = '0'; cursor !== null;) {
        const value: Record<string, any> = await json(c, `${r}/logs?limit=${page}&cursor=${cursor}&orderBy=sequenceNumber&order=asc`);
        storage.appendLogs(prefix, (value.logs ?? []).map((l: any) => ({ message: l.message, level: l.level, timestamp: l.timestamp, metadata: l.metadata ?? undefined })));
        cursor = value.nextCursor ?? null;
      }
    }
    if (!args.skip_files) {
      const scratch = path.join(tmpdir(), `ml-dash-native-${process.pid}-${randomUUID()}`);
      mkdirSync(scratch, { mode: 0o700 });
      try {
        for (const file of (await json(c, `${r}/files`)).files ?? []) {
          const temp = path.join(scratch, 'file');
          const { checksum, bytes } = await saveResponse(await call(c, `${r}/files/${file.id}/download`), temp, true);
          if (checksum !== String(file.checksum).toLowerCase() || bytes !== file.sizeBytes)
            throw nativeError('NATIVE_CHECKSUM_MISMATCH', `File ${file.filename} failed size or SHA-256 verification.`, 'Retry the download; nothing was recorded for this file.');
          await storage.writeFile({ prefix, project, sourcePath: temp, path: String(file.prefix ?? file.path ?? '').replace(/^\/+/, ''), filename: file.filename,
            description: file.description ?? null, tags: file.tags ?? [], metadata: file.metadata ?? null, checksum, contentType: file.contentType, sizeBytes: bytes });
          rmSync(temp, { force: true });
        }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
    console.log(`  ${green('✓')} ${prefix}`);
  }
  return 0;
}

/** Shared error reporting for these human-output commands. */
export async function runNativeTransfer(work: () => Promise<number>): Promise<number> {
  try { return await work(); } catch (e) {
    if (e instanceof ManagementError) { console.error(`${red('Error:')} ${e.code}: ${e.message}\n${e.remediation}`); return 1; }
    console.error(`${red('Error:')} The native request did not complete; a write outcome may be unknown.`);
    return 1;
  }
}

/** `list -p ns/project [--status S] [--tags a,b] --backend native`: the project's native runs. */
export async function listRunsNative(args: ParsedArgs): Promise<number> {
  const c = nativeContext(args);
  refuse(args, ['topic_filter', 'detailed'], 'Native run listing takes --project, --status and --tags.');
  const raw = String(args.project ?? '');
  if (/[*?[\]]/.test(raw)) throw nativeError('NATIVE_GLOB_UNSUPPORTED', 'Native listing does not expand globs.', 'Pass an exact namespace/project.');
  const [ns, project, extra] = raw.replace(/^\/+|\/+$/g, '').split('/');
  if (!ns || !project || extra !== undefined) throw nativeError('NATIVE_INVALID_PATH', '--project must be namespace/project.', 'Native runs live directly in a DreamLake project.');
  const tags = typeof args.tags === 'string' ? args.tags.split(',').map(t => t.trim()).filter(Boolean) : null;
  const runs = (await allRuns(c, ns, project)).filter(run =>
    (args.status === undefined || (args.status === 'ARCHIVED' ? !!run.archivedAt : run.status === args.status && !run.archivedAt)) &&
    (!tags || (run.tags ?? []).some((t: string) => tags.includes(t))));
  if (!runs.length) { console.log(yellow('No runs found')); return 0; }
  console.log(bold(`\nRuns in ${ns}/${project}\n`));
  for (const run of runs) console.log(`  ${cyan(String(run.name))}  ${run.archivedAt ? 'ARCHIVED' : run.status}  ${run.id}`);
  return 0;
}
