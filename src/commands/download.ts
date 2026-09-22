/**
 * `ml-dash download` — pull experiments from a server into a local `.dash` tree.
 *
 * The flag surface and the discover → skip → (dry run) → download shape follow
 * the Python command. Four behaviours differ, each because the Python version
 * reported success while writing nothing:
 *
 *  1. **The local writes actually happen.** Every `self.local.*` call in the
 *     Python downloader passed `project=`/`experiment=` keywords to a
 *     `LocalStorage` whose signature is `(owner, project, prefix, …)`. Each one
 *     raised `TypeError`, each was swallowed by its section's `except`, and
 *     `download_experiment` still set `success = True` — so a download produced
 *     an experiment.json and nothing else, and exited 0.
 *  2. **File fields are read from where the server puts them.** The GraphQL
 *     file page returns `name`/`pPath`/`physicalFile{…}`; Python indexed
 *     `file_info["filename"]`, `["path"]`, `["checksum"]`, so every file failed
 *     with a KeyError even had the write worked.
 *  3. **Checksums are verified.** A file whose SHA-256 does not match the
 *     server's is deleted rather than written into the tree, and the run exits
 *     non-zero. Silent corruption in an archive is worse than a failed pull.
 *  4. **Parameters and metrics are not gated on the list query.** `has_params`
 *     came from a `parameters` field the list query never selects, so a
 *     multi-experiment download skipped every parameter set. Here they are
 *     fetched unless `--skip-params`, and an empty result simply writes nothing.
 *
 * The "already exists locally" check also uses the prefix path the downloader
 * writes to, not `root/project/experiment`, which never matched a real tree.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RemoteClient } from "../client.js";
import { makeClient, notAuthenticatedMessage, resolveContext } from "../cli/context.js";
import type { CommandSpec, ParsedArgs } from "../cli/parser.js";
import { LocalStorage, sha256File } from "../local/storage.js";
import { bold, cyan, dim, formatBytes, green, red, renderTable, yellow } from "../util/ansi.js";
import { hasWildcard } from "../util/glob.js";
import { asId } from "../util/json.js";
import { runPool } from "../util/pool.js";

export const spec: CommandSpec = {
  name: "download",
  help: "Download experiments from remote server to local storage",
  description: `Download experiments from a remote ML-Dash server into local storage.

Examples:
  ml-dash download -p alice/my-project
  ml-dash download ./backup -p alice/my-project --experiment exp-one
  ml-dash download -p 'alice/tut*' --dry-run
  ml-dash download --tracks alice/proj/exp/robot/position -f jsonl -o joints.jsonl`,
  positionals: [
    { dest: "path", metavar: "PATH", default: "./.dash", help: "Local storage directory (default: ./.dash)" },
  ],
  options: [
    { flags: ["--tracks"], dest: "tracks", metavar: "PATH", help: "Download track data from path (e.g., 'namespace/project/exp/robot/position')" },
    { flags: ["-f", "--format"], dest: "format", metavar: "FORMAT", choices: ["json", "jsonl", "parquet", "mcap"], help: "Track export format (default: jsonl)" },
    { flags: ["-o", "--output"], dest: "output", metavar: "FILE", help: "Output file path (default: auto-generated from topic)" },
    { flags: ["--dash-url", "--api-url"], dest: "dash_url", metavar: "URL", help: "ML-Dash server URL (defaults to config or https://api.dash.ml)" },
    { flags: ["-p", "--pref", "--prefix", "--proj", "--project"], dest: "project", metavar: "PROJECT", help: "Filter experiments by project or pattern (supports glob: 'tut*', 'tom*/tutorials/*')" },
    { flags: ["--experiment"], dest: "experiment", metavar: "NAME", help: "Download specific experiment (requires --project)" },
    { flags: ["--skip-logs"], dest: "skip_logs", boolean: true, help: "Don't download logs" },
    { flags: ["--skip-metrics"], dest: "skip_metrics", boolean: true, help: "Don't download metrics" },
    { flags: ["--skip-files"], dest: "skip_files", boolean: true, help: "Don't download files" },
    { flags: ["--skip-params"], dest: "skip_params", boolean: true, help: "Don't download parameters" },
    { flags: ["--dry-run"], dest: "dry_run", boolean: true, help: "Preview without downloading" },
    { flags: ["--overwrite"], dest: "overwrite", boolean: true, help: "Overwrite existing experiments" },
    { flags: ["--resume"], dest: "resume", boolean: true, help: "Resume interrupted download" },
    { flags: ["--state-file"], dest: "state_file", metavar: "FILE", help: "State file path for resume (default: .dash-download-state.json)" },
    { flags: ["--batch-size"], dest: "batch_size", metavar: "N", help: "Batch size for logs/metrics (default: 1000, max: 10000)" },
    { flags: ["--max-concurrent-metrics"], dest: "max_concurrent_metrics", metavar: "N", help: "Parallel metric downloads (default: 5)" },
    { flags: ["--max-concurrent-files"], dest: "max_concurrent_files", metavar: "N", help: "Parallel file downloads (default: 3)" },
    { flags: ["-v", "--verbose"], dest: "verbose", boolean: true, help: "Detailed progress output" },
  ],
};

// ── discovery ────────────────────────────────────────────────────────────────

export interface RemoteExperiment {
  project: string;
  experiment: string;
  experimentId: string;
  owner?: string;
  prefix?: string;
  description?: string | null;
  tags: string[];
  metricNames: string[];
  logCount: number;
  fileCount: number;
  status: string;
}

function fromGraphql(data: any): RemoteExperiment {
  const metadata = data?.metadata ?? {};
  return {
    project: data?.project?.slug ?? "unknown",
    experiment: data.name,
    experimentId: asId(data.id)!,
    owner: data?.project?.namespace?.slug,
    prefix: typeof metadata?.prefix === "string" ? metadata.prefix : undefined,
    description: data?.description ?? null,
    tags: data?.tags ?? [],
    metricNames: (data?.metrics ?? []).map((m: any) => m.name),
    logCount: Number(data?.logMetadata?.totalLogs ?? 0),
    fileCount: (data?.files ?? []).length,
    status: data?.status ?? "RUNNING",
  };
}

async function discoverExperiments(
  client: RemoteClient,
  projectFilter?: string,
  experimentFilter?: string,
): Promise<RemoteExperiment[]> {
  // `-p ns/project` names a project; the server's project slug is its last
  // segment, so a namespaced filter has to be split before it is used.
  const projectSlug = projectFilter?.replace(/^\/+|\/+$/g, "").split("/").slice(1).join("/");

  if (projectFilter && experimentFilter) {
    const exp = await client.getExperimentGraphql(projectSlug || projectFilter, experimentFilter);
    return exp ? [fromGraphql(exp)] : [];
  }

  if (projectFilter && hasWildcard(projectFilter)) {
    const pattern = projectFilter.includes("/") ? projectFilter : `*/${projectFilter}/*`;
    const result = await client.searchExperimentsGraphql(pattern);
    return result.experiments.map(fromGraphql);
  }

  if (projectFilter) {
    const result = await client.listExperimentsGraphql(projectSlug || projectFilter);
    return result.experiments.map(fromGraphql);
  }

  const { projects } = await client.listProjectsGraphql();
  const all: RemoteExperiment[] = [];
  for (const project of projects) {
    const result = await client.listExperimentsGraphql(project.slug);
    all.push(...result.experiments.map(fromGraphql));
  }
  return all;
}

/** Where an experiment lands under the .dash root. */
export function localPrefixFor(exp: RemoteExperiment): string {
  if (exp.prefix) return exp.prefix.replace(/^\/+|\/+$/g, "");
  if (exp.owner) return `${exp.owner}/${exp.project}/${exp.experiment}`;
  return `${exp.project}/${exp.experiment}`;
}

// ── resume state ─────────────────────────────────────────────────────────────

interface DownloadState {
  remote_url: string;
  local_path: string;
  completed_experiments: string[];
  failed_experiments: string[];
  in_progress_experiment: string | null;
  timestamp: string | null;
}

const loadState = (file: string): DownloadState | null => {
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (typeof data?.remote_url !== "string") return null;
    return {
      remote_url: data.remote_url,
      local_path: data.local_path ?? "",
      completed_experiments: data.completed_experiments ?? [],
      failed_experiments: data.failed_experiments ?? [],
      in_progress_experiment: data.in_progress_experiment ?? null,
      timestamp: data.timestamp ?? null,
    };
  } catch (e) {
    console.log(yellow(`Warning: Could not load state file: ${(e as Error).message}`));
    return null;
  }
};

const saveState = (file: string, state: DownloadState): void => {
  state.timestamp = new Date().toISOString();
  writeFileSync(file, JSON.stringify(state, null, 2));
};

// ── downloading one experiment ───────────────────────────────────────────────

interface DownloadResult {
  experiment: string;
  success: boolean;
  downloaded: Record<string, number>;
  failed: Record<string, string[]>;
  errors: string[];
  bytesDownloaded: number;
}

interface DownloaderOptions {
  batchSize: number;
  skipLogs: boolean;
  skipMetrics: boolean;
  skipFiles: boolean;
  skipParams: boolean;
  verbose: boolean;
  maxConcurrentMetrics: number;
  maxConcurrentFiles: number;
}

async function downloadExperiment(
  storage: LocalStorage,
  client: RemoteClient,
  exp: RemoteExperiment,
  opts: DownloaderOptions,
): Promise<DownloadResult> {
  const result: DownloadResult = {
    experiment: `${exp.project}/${exp.experiment}`,
    success: false,
    downloaded: {},
    failed: {},
    errors: [],
    bytesDownloaded: 0,
  };
  const prefix = localPrefixFor(exp);
  const note = (line: string): void => {
    if (opts.verbose) console.log(line);
  };

  try {
    note(dim(`  Downloading ${exp.project}/${exp.experiment}`));
    storage.createExperiment({
      project: exp.project,
      prefix,
      description: exp.description,
      tags: exp.tags,
      bindrs: [],
      metadata: null,
    });

    if (!opts.skipParams) {
      try {
        const params = await client.getParameters(exp.experimentId);
        if (params && Object.keys(params).length > 0) {
          storage.writeParameters(prefix, params);
          result.downloaded.parameters = Object.keys(params).length;
          result.bytesDownloaded += Buffer.byteLength(JSON.stringify(params), "utf8");
          note(`  ${green("✓")} ${result.downloaded.parameters} parameters`);
        }
      } catch (e) {
        (result.failed.parameters ??= []).push((e as Error).message);
      }
    }

    if (!opts.skipLogs) {
      try {
        let offset = 0;
        let total = 0;
        for (;;) {
          const page = await client.queryLogs(exp.experimentId, {
            limit: opts.batchSize,
            offset,
            orderBy: "sequenceNumber",
            order: "asc",
          });
          const logs = page?.logs ?? [];
          if (logs.length === 0) break;
          storage.appendLogs(
            prefix,
            logs.map((log: any) => ({
              message: log.message,
              level: log.level,
              timestamp: log.timestamp,
              metadata: log.metadata,
            })),
          );
          total += logs.length;
          result.bytesDownloaded += logs.reduce(
            (n: number, log: any) => n + Buffer.byteLength(JSON.stringify(log), "utf8"),
            0,
          );
          if (!page?.hasMore) break;
          offset += logs.length;
        }
        result.downloaded.logs = total;
        note(`  ${green("✓")} ${total} log entries`);
      } catch (e) {
        (result.failed.logs ??= []).push((e as Error).message);
      }
    }

    if (!opts.skipMetrics) {
      let names = exp.metricNames;
      if (names.length === 0) {
        // The list query only carries names when the server filled them in;
        // asking directly is what keeps a metric from being skipped silently.
        try {
          names = (await client.listMetrics(exp.experimentId))
            .map((m: any) => m?.name)
            .filter((n: unknown): n is string => typeof n === "string");
        } catch (e) {
          (result.failed.metrics ??= []).push((e as Error).message);
          names = [];
        }
      }

      if (names.length > 0) {
        const outcomes = await runPool(names, opts.maxConcurrentMetrics, (name) =>
          downloadMetric(storage, client, exp.experimentId, prefix, name, opts.batchSize),
        );
        let ok = 0;
        outcomes.forEach((outcome, i) => {
          if (outcome.error) {
            (result.failed.metrics ??= []).push(`${names[i]}: ${outcome.error.message}`);
            return;
          }
          ok++;
          result.bytesDownloaded += outcome.value!.bytes;
          note(`  ${green("✓")} metric '${names[i]}': ${outcome.value!.points} points`);
        });
        result.downloaded.metrics = ok;
      }
    }

    if (!opts.skipFiles) {
      await downloadFiles(storage, client, exp, prefix, result, opts);
    }

    const failedSections = Object.keys(result.failed);
    if (failedSections.length > 0) {
      result.success = false;
      result.errors.push(
        `${failedSections.join(", ")} failed: ` +
          failedSections.flatMap((s) => result.failed[s]).slice(0, 3).join("; "),
      );
    } else {
      result.success = true;
    }
  } catch (e) {
    result.success = false;
    result.errors.push((e as Error).message);
  }

  return result;
}

/**
 * One metric, chunks first.
 *
 * Sealed chunks come down in parallel and the still-open buffer is fetched
 * separately; if any of that fails the whole metric falls back to index
 * pagination, which every server supports.
 */
async function downloadMetric(
  storage: LocalStorage,
  client: RemoteClient,
  experimentId: string,
  prefix: string,
  metricName: string,
  batchSize: number,
): Promise<{ points: number; bytes: number }> {
  try {
    const stats = await client.getMetricStats(experimentId, metricName);
    const totalChunks = Number(stats?.totalChunks ?? 0);
    const buffered = Number(stats?.bufferedDataPoints ?? 0);
    const all: any[] = [];

    if (totalChunks > 0) {
      const indices = Array.from({ length: totalChunks }, (_, i) => i);
      const outcomes = await runPool(indices, Math.min(10, totalChunks), async (i) => {
        const chunk = await client.downloadMetricChunk(experimentId, metricName, i);
        return chunk?.data ?? [];
      });
      for (const outcome of outcomes) {
        if (outcome.error) throw outcome.error;
        all.push(...outcome.value!);
      }
    }
    if (buffered > 0) {
      const response = await client.getMetricData(experimentId, metricName, { bufferOnly: true });
      all.push(...(response?.data ?? []));
    }
    if (totalChunks === 0 && buffered === 0) {
      throw new Error("no chunk or buffer counts reported");
    }

    all.sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0));
    let bytes = 0;
    for (let i = 0; i < all.length; i += 10_000) {
      const batch = all.slice(i, i + 10_000);
      storage.appendBatchToMetric(prefix, metricName, batch.map((d) => d.data));
      bytes += batch.reduce((n, d) => n + Buffer.byteLength(JSON.stringify(d), "utf8"), 0);
    }
    return { points: all.length, bytes };
  } catch {
    let startIndex = 0;
    let points = 0;
    let bytes = 0;
    for (;;) {
      const response = await client.getMetricData(experimentId, metricName, {
        startIndex,
        limit: batchSize,
      });
      const data = response?.data ?? [];
      if (data.length === 0) break;
      storage.appendBatchToMetric(prefix, metricName, data.map((d: any) => d.data));
      points += data.length;
      bytes += data.reduce((n: number, d: any) => n + Buffer.byteLength(JSON.stringify(d), "utf8"), 0);
      if (!response?.hasMore) break;
      startIndex += data.length;
    }
    return { points, bytes };
  }
}

interface RemoteFile {
  id: string;
  filename: string;
  filePath: string;
  description: string | null;
  tags: string[];
  metadata: Record<string, unknown> | null;
  checksum: string;
  contentType: string;
  sizeBytes: number;
}

/** Flatten a GraphQL file node into the fields local storage records. */
function normalizeFile(node: any): RemoteFile {
  const physical = node?.physicalFile ?? {};
  return {
    id: asId(node?.id)!,
    filename: physical.filename ?? node?.name ?? "unnamed",
    filePath: typeof node?.pPath === "string" ? node.pPath.replace(/^\/+/, "") : "",
    description: node?.description ?? null,
    tags: node?.tags ?? [],
    metadata: node?.metadata ?? null,
    checksum: physical.checksum ?? "",
    contentType: physical.contentType ?? "",
    sizeBytes: physical.sizeBytes != null ? Number(physical.sizeBytes) : 0,
  };
}

async function downloadFiles(
  storage: LocalStorage,
  client: RemoteClient,
  exp: RemoteExperiment,
  prefix: string,
  result: DownloadResult,
  opts: DownloaderOptions,
): Promise<void> {
  const limit = 500;
  let offset = 0;

  for (;;) {
    let page: any;
    try {
      page = await client.listFiles(exp.experimentId, limit, offset);
    } catch (e) {
      (result.failed.files ??= []).push(`List files failed: ${(e as Error).message}`);
      return;
    }
    const nodes = page?.files ?? [];
    if (nodes.length === 0) break;

    const files: RemoteFile[] = nodes.map(normalizeFile);
    const outcomes = await runPool(files, opts.maxConcurrentFiles, (file) =>
      downloadSingleFile(storage, client, prefix, exp.project, file),
    );

    outcomes.forEach((outcome, i) => {
      if (outcome.error) {
        (result.failed.files ??= []).push(`${files[i].filename}: ${outcome.error.message}`);
        return;
      }
      result.downloaded.files = (result.downloaded.files ?? 0) + 1;
      result.bytesDownloaded += outcome.value!;
      if (opts.verbose) console.log(`  ${green("✓")} ${files[i].filename}`);
    });

    if (!page?.hasMore) break;
    offset += limit;
  }
}

async function downloadSingleFile(
  storage: LocalStorage,
  client: RemoteClient,
  prefix: string,
  project: string,
  file: RemoteFile,
): Promise<number> {
  const scratch = mkdtempSync(path.join(tmpdir(), "ml-dash-download-"));
  // A fixed local name: the server's filename decides where the file lands in
  // the .dash tree (checked there), never where the unverified bytes land
  // here, so a '../' in it cannot write over anything outside the scratch dir.
  const temp = path.join(scratch, "payload");
  try {
    await client.downloadFileStreaming(file.id, temp);

    if (file.checksum) {
      const actual = await sha256File(temp);
      if (actual !== file.checksum) {
        // Deleted, not stored: a corrupt archive entry that looks complete is
        // worse than a download that says it failed.
        throw new Error(`checksum mismatch (expected ${file.checksum}, got ${actual})`);
      }
    }

    await storage.writeFile({
      prefix,
      project,
      sourcePath: temp,
      path: file.filePath,
      filename: file.filename,
      description: file.description,
      tags: file.tags,
      metadata: file.metadata,
      checksum: file.checksum,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    });
    return file.sizeBytes;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── track download ───────────────────────────────────────────────────────────

async function downloadTrack(args: ParsedArgs): Promise<number> {
  const ctx = resolveContext(args);
  const trackPath = String(args.tracks).replace(/^\/+|\/+$/g, "");
  const format = typeof args.format === "string" ? args.format : "jsonl";
  const parts = trackPath.split("/");

  if (parts.length < 4) {
    console.error(
      `${red("Error:")} Track path must be in format: 'namespace/project/experiment/topic'`,
    );
    console.error("Examples:");
    console.error("  geyang/project/experiment/position");
    console.error("  geyang/project/experiment/robot/position");
    console.error("  geyang/project/folder/experiment/robot/camera/position");
    return 1;
  }
  if (!ctx.apiKey) {
    console.error(`${red("Error:")} ${notAuthenticatedMessage(ctx)}`);
    return 1;
  }

  const [namespace, project] = parts;
  const client = makeClient(ctx, namespace);

  // Experiments can sit under folders, so the split between the experiment
  // path and the topic is found by trying each one.
  let experiment: any = null;
  let experimentName = "";
  let topic = "";
  const tried: string[] = [];

  for (let split = 3; split <= parts.length; split++) {
    const candidateName = parts.slice(2, split).join("/");
    const candidateTopic = parts.slice(split).join("/");
    if (!candidateTopic) continue;
    tried.push(candidateName);

    for (const lookup of [
      () => client.getExperimentByPathGraphql(project, candidateName, namespace),
      () => client.getExperimentGraphql(project, candidateName, namespace),
    ]) {
      try {
        const found = await lookup();
        if (found) {
          experiment = found;
          experimentName = candidateName;
          topic = candidateTopic;
          break;
        }
      } catch {
        // Try the next lookup, then the next split point.
      }
    }
    if (experiment) break;
  }

  if (!experiment) {
    console.error(`${red("Error:")} Could not find valid experiment in path: ${trackPath}`);
    console.error("\nTried the following experiment names:");
    for (const name of tried) console.error(`  - ${name}`);
    console.error(`\nMake sure the experiment exists in project '${project}'`);
    return 1;
  }

  console.log(bold("Downloading track data..."));
  console.log(`  Namespace: ${namespace}`);
  console.log(`  Project: ${project}`);
  console.log(`  Experiment: ${experimentName}`);
  console.log(`  Topic: ${topic}`);
  console.log(`  Format: ${format}`);

  try {
    console.log(`\n${cyan("Fetching track data from server...")}`);
    const data = await client.getTrackData(String(experiment.id), topic, format);
    const output = path.resolve(
      typeof args.output === "string" ? args.output : `${topic.replace(/\//g, "_")}.${format}`,
    );

    if (Buffer.isBuffer(data)) writeFileSync(output, data);
    else writeFileSync(output, JSON.stringify(data, null, 2));

    const size = Buffer.isBuffer(data)
      ? data.length
      : Buffer.byteLength(JSON.stringify(data, null, 2), "utf8");
    console.log(`\n${green("✓ Track data downloaded successfully")}`);
    console.log(`  Output: ${output}`);
    console.log(`  Size: ${formatBytes(size)}`);
    console.log(`  Format: ${format}`);
    if (format === "json" && !Buffer.isBuffer(data)) {
      const count = (data as any).count ?? ((data as any).entries ?? []).length;
      if (count) console.log(`  Entries: ${count}`);
    }
    return 0;
  } catch (e) {
    console.error(`${red("Error downloading track data:")} ${(e as Error).message}`);
    return 1;
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

const positiveInt = (value: unknown, fallback: number): number => {
  if (value === undefined) return fallback;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : Number.NaN;
};

export async function run(args: ParsedArgs): Promise<number> {
  if (args.tracks) return downloadTrack(args);

  const ctx = resolveContext(args);
  const batchSize = positiveInt(args.batch_size, 1000);
  const maxMetrics = positiveInt(args.max_concurrent_metrics, 5);
  const maxFiles = positiveInt(args.max_concurrent_files, 3);
  for (const [flag, value] of [
    ["--batch-size", batchSize],
    ["--max-concurrent-metrics", maxMetrics],
    ["--max-concurrent-files", maxFiles],
  ] as const) {
    if (!Number.isFinite(value)) {
      console.error(`${red("Error:")} ${flag} must be a positive integer`);
      return 1;
    }
  }

  const projectFilter = typeof args.project === "string" ? args.project : undefined;
  const namespace = projectFilter?.replace(/^\/+|\/+$/g, "").split("/")[0];
  if (!projectFilter || projectFilter.replace(/^\/+|\/+$/g, "").split("/").length < 2) {
    console.error(
      `${red("Error:")} --project must be in format 'namespace/project' or 'namespace/project/exp'`,
    );
    console.error("Example: ml-dash download --project alice/my-project");
    return 1;
  }
  if (!ctx.apiKey) {
    console.error(`${red("Error:")} ${notAuthenticatedMessage(ctx)}`);
    return 1;
  }

  const localPath = path.resolve(String(args.path ?? "./.dash"));
  const client = makeClient(ctx, namespace);
  const storage = new LocalStorage(localPath);

  const stateFile = path.resolve(String(args.state_file ?? ".dash-download-state.json"));
  let state = args.resume ? loadState(stateFile) : null;
  if (args.resume) {
    if (state) {
      console.log(cyan(`Resuming from previous download (${state.completed_experiments.length} completed)`));
    } else {
      console.log(yellow("No previous state found, starting fresh"));
    }
  }
  state ??= {
    remote_url: ctx.remoteUrl,
    local_path: localPath,
    completed_experiments: [],
    failed_experiments: [],
    in_progress_experiment: null,
    timestamp: null,
  };

  console.log(bold("Discovering experiments on remote server..."));
  let experiments: RemoteExperiment[];
  try {
    experiments = await discoverExperiments(
      client,
      projectFilter,
      typeof args.experiment === "string" ? args.experiment : undefined,
    );
  } catch (e) {
    console.error(red(`Failed to discover experiments: ${(e as Error).message}`));
    return 1;
  }

  if (experiments.length === 0) {
    console.log(yellow("No experiments found"));
    return 0;
  }
  console.log(`Found ${experiments.length} experiment(s)`);

  const queued: RemoteExperiment[] = [];
  for (const exp of experiments) {
    const key = `${exp.project}/${exp.experiment}`;
    if (state.completed_experiments.includes(key) && !args.overwrite) {
      console.log(dim(`  Skipping ${key} (already completed)`));
      continue;
    }
    const expJson = path.join(storage.experimentDir(localPrefixFor(exp)), "experiment.json");
    if (existsSync(expJson) && !args.overwrite) {
      console.log(yellow(`  Skipping ${key} (already exists locally)`));
      continue;
    }
    queued.push(exp);
  }

  if (queued.length === 0) {
    console.log(green("All experiments already downloaded"));
    return 0;
  }

  if (args.dry_run) {
    console.log(`\n${bold("Dry run - would download:")}`);
    for (const exp of queued) {
      console.log(`  • ${exp.project}/${exp.experiment}`);
      console.log(
        `    Logs: ${exp.logCount}, Metrics: ${exp.metricNames.length}, Files: ${exp.fileCount}`,
      );
    }
    return 0;
  }

  const opts: DownloaderOptions = {
    batchSize,
    skipLogs: args.skip_logs === true,
    skipMetrics: args.skip_metrics === true,
    skipFiles: args.skip_files === true,
    skipParams: args.skip_params === true,
    verbose: args.verbose === true,
    maxConcurrentMetrics: maxMetrics,
    maxConcurrentFiles: maxFiles,
  };

  console.log(`\n${bold(`Downloading ${queued.length} experiment(s)...`)}`);
  const started = Date.now();
  const results: DownloadResult[] = [];

  for (let i = 0; i < queued.length; i++) {
    const exp = queued[i];
    const key = `${exp.project}/${exp.experiment}`;
    console.log(`\n${cyan(`[${i + 1}/${queued.length}] ${key}`)}`);

    state.in_progress_experiment = key;
    saveState(stateFile, state);

    const result = await downloadExperiment(storage, client, exp, opts);
    results.push(result);

    if (result.success) {
      state.completed_experiments.push(key);
      console.log(`  ${green("✓ Downloaded successfully")}`);
    } else {
      state.failed_experiments.push(key);
      console.log(`  ${red(`✗ Failed: ${result.errors.join(", ")}`)}`);
    }

    state.in_progress_experiment = null;
    saveState(stateFile, state);
  }

  const elapsed = (Date.now() - started) / 1000;
  const totalBytes = results.reduce((n, r) => n + r.bytesDownloaded, 0);
  const successful = results.filter((r) => r.success).length;

  const rows: string[][] = [
    ["Total Experiments", String(results.length)],
    ["Successful", String(successful)],
    ["Failed", String(results.length - successful)],
    ["Total Data", formatBytes(totalBytes)],
    ["Total Time", `${elapsed.toFixed(2)}s`],
  ];
  if (elapsed > 0) rows.push(["Avg Speed", `${formatBytes(totalBytes / elapsed)}/s`]);

  console.log(`\n${bold("Download Summary")}`);
  console.log(renderTable([{ header: "Metric" }, { header: "Value" }], rows));

  if (successful === results.length) {
    if (existsSync(stateFile)) unlinkSync(stateFile);
    return 0;
  }
  return 1;
}
