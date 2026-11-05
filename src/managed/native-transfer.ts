/**
 * `upload`, `download` and `list` with `--backend native`.
 *
 * Local `.dash` transfer runs through the existing upload/download pipelines (discovery,
 * validation, --strict, --resume/--state-file, batching, concurrency, --overwrite, skips)
 * with the native adapters below in place of the standalone RemoteClient. Tracks use their
 * own native routes. Everything uses the shared DreamLake login (managed `context`), and
 * nothing falls back to a standalone Dash server.
 *
 * Native runs live directly in a DreamLake project, so only flat run prefixes
 * (`<namespace>/<project>/<run>`) can be stored; folders, bindrs, write protection and run
 * metadata have no native contract yet and are refused before any write, never dropped.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, linkSync, openAsBlob, renameSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ParsedArgs } from '../cli/parser.js';
import type { LocalStorage } from '../local/storage.js';
import type { ExperimentInfo, ExperimentUploadClient } from '../commands/upload.js';
import type { ExperimentDownloadClient, RemoteExperiment } from '../commands/download.js';
import { bold, cyan, green, red, yellow } from '../util/ansi.js';
import { context, ManagementError, type Context } from './client.js';
import { call, json, nativeError } from './native.js';

const RUN_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const METRIC = /^[A-Za-z0-9_.-]{1,128}$/;
const LEVELS = ['info', 'warn', 'error', 'debug', 'fatal'];
/** Native per-request limits; larger --batch-size values are split, never truncated. */
const MAX_BATCH = 1000;
const runsBase = (ns: string, project: string) => `/native-experiments/ns/${encodeURIComponent(ns)}/projects/${encodeURIComponent(project)}`;
const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

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

/**
 * Runs of a project (archived included), page by page until the server reports no next page.
 * `stop` ends the scan early. A repeated cursor is a server paging fault and stops it.
 */
async function eachRun(c: Context, ns: string, project: string, stop: (run: any) => boolean = () => false): Promise<any[]> {
  const runs: any[] = [];
  const seen = new Set<string>();
  for (let cursor: string | null = null; ;) {
    const value: Record<string, any> = await json(c, `${runsBase(ns, project)}/runs?limit=100&includeArchived=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!Array.isArray(value.runs)) throw nativeError('NATIVE_INVALID_RESPONSE', 'Invalid run list.', 'Check matching server versions.');
    for (const run of value.runs) { runs.push(run); if (stop(run)) return runs; }
    if (!value.nextCursor) return runs;
    if (typeof value.nextCursor !== 'string' || seen.has(value.nextCursor))
      throw nativeError('NATIVE_CURSOR_LOOP', 'The server repeated a run cursor.', 'Retry after the server paging issue is resolved.');
    seen.add(value.nextCursor);
    cursor = value.nextCursor;
  }
}
/** The run with this key, without creating one (the old CLI required an existing experiment). Keys are unique per project. */
async function runByKey(c: Context, ns: string, project: string, key: string) {
  const found = (await eachRun(c, ns, project, run => run.name === key)).find(run => run.name === key);
  if (!found) throw nativeError('NATIVE_RUN_NOT_FOUND', `Run '${key}' was not found in ${ns}/${project}.`, 'Create it with ml-dash runs create --backend native, or check the key.');
  return found;
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

// ── upload adapter ──────────────────────────────────────────────────────────

/** A flat `<namespace>/<project>/<run>` prefix, or null when it names folders. */
function flatPrefix(prefix: string) {
  const parts = prefix.replace(/^\/+|\/+$/g, '').split('/');
  return parts.length === 3 && parts.every(Boolean) ? { ns: parts[0]!, project: parts[1]!, key: parts[2]! } : null;
}

/** RemoteClient's upload surface over native REST. Run IDs map to their project route. */
class NativeUploadClient implements ExperimentUploadClient {
  private readonly bases = new Map<string, string>();
  constructor(private readonly c: Context) {}
  private run(id: string) {
    const base = this.bases.get(id);
    if (!base) throw new Error(`unknown native run ${id}`);
    return `${base}/runs/${id}`;
  }
  async createOrUpdateExperiment(args: Parameters<ExperimentUploadClient['createOrUpdateExperiment']>[0]): Promise<any> {
    const target = flatPrefix(args.prefix ?? '');
    if (!target || target.key !== args.name || target.project !== args.project)
      throw new Error(`prefix '${args.prefix}' is not a flat native run of project '${args.project}'`);
    if ((args.bindrs ?? []).length || args.writeProtected || args.metadata && Object.keys(args.metadata).length)
      throw new Error('bindrs, write protection and run metadata have no native contract');
    const body: Record<string, unknown> = {};
    // A string clears or sets ('' clears); null means "not recorded" and leaves the run as it is.
    if (typeof args.description === 'string') body.description = args.description;
    if (Array.isArray(args.tags)) body.tags = args.tags;
    const base = runsBase(target.ns, target.project);
    const value = await json(this.c, `${base}/runs/${encodeURIComponent(target.key)}`, 'PUT', body);
    this.bases.set(String(value.experiment?.id), base);
    return value;
  }
  async setParameters(id: string, data: Record<string, unknown>): Promise<any> {
    return json(this.c, `${this.run(id)}/parameters`, 'POST', { data });
  }
  async createLogEntries(id: string, logs: Record<string, unknown>[]): Promise<any> {
    for (const batch of chunks(logs, MAX_BATCH)) await json(this.c, `${this.run(id)}/logs`, 'POST', { entries: batch });
    return { count: logs.length };
  }
  async appendBatchToMetric(id: string, name: string, points: unknown[]): Promise<any> {
    for (const batch of chunks(points, MAX_BATCH)) await json(this.c, `${this.run(id)}/metrics/${encodeURIComponent(name)}`, 'POST', { dataPoints: batch });
    return { count: points.length };
  }
  async uploadFile(args: Parameters<ExperimentUploadClient['uploadFile']>[0]): Promise<any> {
    const blob = await openAsBlob(args.filePath, { type: args.contentType || 'application/octet-stream' });
    const hash = createHash('sha256');
    for await (const chunk of blob.stream() as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
    const form = new FormData();
    form.append('sizeBytes', String(blob.size));
    form.append('checksum', hash.digest('hex'));
    form.append('prefix', '/' + (args.prefix ?? '').replace(/^\/+/, ''));
    if (args.description) form.append('description', args.description);
    if (args.tags?.length) form.append('tags', args.tags.join(','));
    if (args.metadata) form.append('metadata', JSON.stringify(args.metadata));
    form.append('file', blob, args.filename);
    return json(this.c, `${this.run(args.experimentId)}/files`, 'POST', undefined, form);
  }
}

interface PreflightItem { info: ExperimentInfo; validation: { metadata?: Record<string, any> }; fullPrefix: string; targetProject: string }

/** Every reason an experiment would reach native storage incompletely. Checked for all experiments before the first write. */
function preflight(storage: LocalStorage, items: PreflightItem[], skipLogs: boolean, skipMetrics: boolean): string[] {
  const problems: string[] = [];
  for (const { info, validation, fullPrefix, targetProject } of items) {
    const name = `${info.project}/${info.experiment}`;
    const target = flatPrefix(fullPrefix);
    if (!target) { problems.push(`${name}: '${fullPrefix}' is inside folders (NATIVE_FOLDERS_PENDING); native folders are not available yet.`); continue; }
    if (target.project !== targetProject || target.key !== info.experiment)
      problems.push(`${name}: prefix '${fullPrefix}' does not name project '${targetProject}' and run '${info.experiment}'.`);
    if (!RUN_KEY.test(info.experiment)) problems.push(`${name}: '${info.experiment}' is not a native run key (letters, digits, '_' or '-').`);
    const meta = validation.metadata ?? {};
    if (Array.isArray(meta.bindrs) && meta.bindrs.length) problems.push(`${name}: bindrs ${JSON.stringify(meta.bindrs)} have no native contract yet.`);
    if (meta.write_protected === true) problems.push(`${name}: write_protected has no native contract yet.`);
    if (meta.metadata && typeof meta.metadata === 'object' && Object.keys(meta.metadata).length) problems.push(`${name}: experiment metadata has no native run contract yet.`);
    if (!skipMetrics) for (const metric of info.metrics) {
      if (!METRIC.test(metric.name)) { problems.push(`${name}: metric '${metric.name}' is not a native metric name (letters, digits, '.', '_' or '-').`); continue; }
      if (storage.readMetricPoints(metric).points.some(p => !p || typeof p !== 'object' || Array.isArray(p)))
        problems.push(`${name}: metric '${metric.name}' has non-object points, which native metrics do not store.`);
    }
    if (!skipLogs && info.hasLogs) {
      let bad = 0;
      // Lines without `message` stay skipped with a warning, as before; uploaded entries need what the native API requires.
      for (const line of readFileSync(path.join(info.dir, 'logs', 'logs.jsonl'), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry: any; try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry !== 'object' || !('message' in entry)) continue;
        if (typeof entry.message !== 'string' || typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp)) ||
            entry.level !== undefined && !LEVELS.includes(entry.level)) bad++;
      }
      if (bad) problems.push(`${name}: ${bad} log entr${bad === 1 ? 'y needs' : 'ies need'} a string message, an ISO timestamp and a native level.`);
    }
  }
  return problems;
}

/** The upload pipeline's native target: its client, state identity and pre-write check. */
export function nativeUploadTarget(args: ParsedArgs) {
  const c = nativeContext(args);
  return { client: new NativeUploadClient(c), server: c.url, stateIdentity: `native:${c.url}`, preflight };
}

// ── download adapter ────────────────────────────────────────────────────────

/** RemoteClient's download surface over native REST, for one DreamLake project. */
class NativeDownloadClient implements ExperimentDownloadClient {
  private readonly fileRuns = new Map<string, string>();
  constructor(private readonly c: Context, private readonly base: string) {}
  private run(id: string) { return `${this.base}/runs/${encodeURIComponent(id)}`; }
  async getParameters(id: string): Promise<Record<string, unknown>> {
    try {
      const value = (await json(this.c, `${this.run(id)}/parameters`)).parameters;
      const data = value && typeof value === 'object' && value.data && typeof value.data === 'object' ? value.data : value;
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (e) {
      if (e instanceof ManagementError && (e.code === 'NATIVE_PARAMETERS_NOT_FOUND' || e.code === 'NATIVE_HTTP_404')) return {};
      throw e;
    }
  }
  async queryLogs(id: string, opts: Parameters<ExperimentDownloadClient['queryLogs']>[1] = {}): Promise<any> {
    const q = new URLSearchParams({ limit: String(Math.min(opts.limit ?? MAX_BATCH, MAX_BATCH)), cursor: String(opts.offset ?? 0) });
    if (opts.orderBy) q.set('orderBy', opts.orderBy);
    if (opts.order) q.set('order', opts.order);
    const value = await json(this.c, `${this.run(id)}/logs?${q}`);
    return { logs: value.logs ?? [], hasMore: value.hasMore === true };
  }
  async listMetrics(id: string): Promise<any[]> { return (await json(this.c, `${this.run(id)}/metrics`)).metrics ?? []; }
  /** Native metrics have no chunk index: the pipeline reads them by index pages instead. */
  async getMetricStats(): Promise<any> { throw new Error('native metrics are read by index pages'); }
  async downloadMetricChunk(): Promise<any> { throw new Error('native metrics are read by index pages'); }
  async getMetricData(id: string, name: string, opts: { startIndex?: number; limit?: number; bufferOnly?: boolean } = {}): Promise<any> {
    if (opts.bufferOnly) throw new Error('native metrics are read by index pages');
    const q = new URLSearchParams({ limit: String(Math.min(opts.limit ?? MAX_BATCH, MAX_BATCH)), cursor: String(opts.startIndex ?? 0) });
    const value = await json(this.c, `${this.run(id)}/metrics/${encodeURIComponent(name)}?${q}`);
    return { data: (value.rows ?? []).map((row: unknown) => ({ data: row })), hasMore: value.nextCursor != null };
  }
  /** Native file listing is one response: the first page holds every file. */
  async listFiles(id: string, _limit = 500, offset = 0): Promise<any> {
    if (offset > 0) return { files: [], hasMore: false };
    const files = (await json(this.c, `${this.run(id)}/files`)).files ?? [];
    for (const f of files) this.fileRuns.set(String(f.id), id);
    return { files: files.map((f: any) => ({ id: f.id, name: f.filename, pPath: f.prefix ?? f.path ?? '', description: f.description ?? null,
      tags: f.tags ?? [], metadata: f.metadata ?? null,
      physicalFile: { filename: f.filename, checksum: f.checksum, contentType: f.contentType, sizeBytes: f.sizeBytes } })), hasMore: false };
  }
  async downloadFileStreaming(fileId: string, destPath: string): Promise<string> {
    const runId = this.fileRuns.get(fileId);
    if (!runId) throw new Error(`file ${fileId} was not listed`);
    const response = await call(this.c, `${this.run(runId)}/files/${encodeURIComponent(fileId)}/download`);
    if (!response.body) throw new Error('empty download body');
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(destPath));
    return destPath;
  }
}

/** The download pipeline's native source: `-p namespace/project[/run]`, no globs (no native search yet). */
export function nativeDownloadSource(args: ParsedArgs) {
  const raw = String(args.project ?? '').replace(/^\/+|\/+$/g, '');
  if (/[*?[\]]/.test(raw)) throw nativeError('NATIVE_GLOB_UNSUPPORTED', 'Native download does not expand project globs.', 'Pass an exact namespace/project; native search is not available yet.');
  const [ns, project, key, extra] = raw.split('/');
  if (!ns || !project || extra !== undefined) throw nativeError('NATIVE_INVALID_PATH', '--project must be namespace/project or namespace/project/run.', 'Native runs live directly in a DreamLake project; folders are not available yet.');
  if (key && typeof args.experiment === 'string' && args.experiment !== key)
    throw nativeError('NATIVE_INVALID_PATH', '--project names a different run than --experiment.', 'Give the run once.');
  const c = nativeContext(args);
  const base = runsBase(ns, project);
  return {
    client: new NativeDownloadClient(c, base),
    stateIdentity: `native:${c.url}`,
    async discover(experiment?: string): Promise<RemoteExperiment[]> {
      const wanted = experiment ?? key;
      const runs = await eachRun(c, ns, project, wanted ? run => run.name === wanted : undefined);
      return runs.filter(run => !wanted || run.name === wanted).map(run => ({ project, experiment: run.name, experimentId: run.id, owner: ns,
        description: run.description ?? null, tags: run.tags ?? [], metricNames: [], fileCount: 0, status: run.status ?? 'RUNNING', countsUnknown: true }));
    },
  };
}

export function reportNativeError(e: unknown): number {
  if (e instanceof ManagementError) console.error(`${red('Error:')} ${e.code}: ${e.message}\n${e.remediation}`);
  else console.error(`${red('Error:')} The native request did not complete; a write outcome may be unknown.`);
  return 1;
}

// ── tracks ──────────────────────────────────────────────────────────────────

/** `upload --tracks FILE --remote-path ns/project/run/topic --backend native` */
export async function uploadTrackNative(args: ParsedArgs): Promise<number> {
  const c = nativeContext(args);
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
  for (const batch of chunks(entries, 1000)) {
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

/** `list -p ns/project [--status S] [--tags a,b] --backend native`: the project's native runs. */
export async function listRunsNative(args: ParsedArgs): Promise<number> {
  const c = nativeContext(args);
  refuse(args, ['topic_filter', 'detailed'], 'Native run listing takes --project, --status and --tags.');
  const raw = String(args.project ?? '');
  if (/[*?[\]]/.test(raw)) throw nativeError('NATIVE_GLOB_UNSUPPORTED', 'Native listing does not expand globs.', 'Pass an exact namespace/project.');
  const [ns, project, extra] = raw.replace(/^\/+|\/+$/g, '').split('/');
  if (!ns || !project || extra !== undefined) throw nativeError('NATIVE_INVALID_PATH', '--project must be namespace/project.', 'Native runs live directly in a DreamLake project.');
  const tags = typeof args.tags === 'string' ? args.tags.split(',').map(t => t.trim()).filter(Boolean) : null;
  const runs = (await eachRun(c, ns, project)).filter(run =>
    (args.status === undefined || (args.status === 'ARCHIVED' ? !!run.archivedAt : run.status === args.status && !run.archivedAt)) &&
    (!tags || (run.tags ?? []).some((t: string) => tags.includes(t))));
  if (!runs.length) { console.log(yellow('No runs found')); return 0; }
  console.log(bold(`\nRuns in ${ns}/${project}\n`));
  for (const run of runs) console.log(`  ${cyan(String(run.name))}  ${run.archivedAt ? 'ARCHIVED' : run.status}  ${run.id}`);
  return 0;
}

/** Shared error reporting for the human-output track and list commands. */
export async function runNativeTransfer(work: () => Promise<number>): Promise<number> {
  try { return await work(); } catch (e) { return reportNativeError(e); }
}
