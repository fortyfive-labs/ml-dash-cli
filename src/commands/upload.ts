/**
 * `ml-dash upload` — push a local `.dash` tree to a server.
 *
 * The shape of the Python command is preserved: discover → validate → (dry
 * run) → upload, with a resume state file and per-section skip flags. Three
 * behaviours differ from the Python implementation on purpose, because each
 * one silently dropped data there:
 *
 *  1. **Both metric layouts are uploaded.** Python's discovery only looked at
 *     `metrics/<name>/data.jsonl`, so an experiment whose metrics were written
 *     by `write_metric_data` (the flat `metrics/<name>.jsonl` form) uploaded as
 *     a success with none of its metrics. Discovery here goes through
 *     `LocalStorage.listMetrics`, which reads both.
 *  2. **Files are read from where they are.** Python used the *declared*
 *     `prefix` in experiment.json to locate the files directory, and skipped
 *     file upload entirely when that prefix had fewer than three segments.
 *     Here the on-disk location is used for reading and the declared prefix is
 *     sent to the server, so a short or stale prefix costs a server path, not
 *     the files.
 *  3. **A section that fails fails the experiment.** Python recorded a failed
 *     log/metric/file batch in `result.failed` and still set `success = True`,
 *     so a run that uploaded metadata and lost every metric exited 0 and
 *     deleted its own resume state. Here any failed section marks the
 *     experiment failed, which keeps the state file and exits 1.
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RemoteClient } from "../client.js";
import { makeClient, notAuthenticatedMessage, resolveContext } from "../cli/context.js";
import type { CommandSpec, ParsedArgs } from "../cli/parser.js";
import { LocalStorage, type LocalMetric } from "../local/storage.js";
import { bold, cyan, dim, formatBytes, green, red, renderTable, yellow } from "../util/ansi.js";
import { fnmatch, hasWildcard } from "../util/glob.js";
import { parseJson } from "../util/json.js";
import { runPool } from "../util/pool.js";

/** Metric uploads run in parallel, as `ThreadPoolExecutor(max_workers=5)` did. */
const METRIC_WORKERS = 5;

export const spec: CommandSpec = {
  name: "upload",
  help: "Upload local experiments to remote server",
  description: `Upload locally-stored ML-Dash experiment data to a remote server.

Examples:
  ml-dash upload
  ml-dash upload ./.dash -p 'tom/*/exp*'
  ml-dash upload --dry-run -v
  ml-dash upload -t alice/shared-project
  ml-dash upload --tracks robot_position.jsonl --remote-path tom/proj/exp/robot/position`,
  positionals: [
    { dest: "path", metavar: "PATH", default: "./.dash", help: "Local storage directory to upload from (default: ./.dash)" },
  ],
  options: [
    { flags: ["--dash-url", "--api-url"], dest: "dash_url", metavar: "URL", help: "ML-Dash server URL (defaults to config or https://api.dash.ml)" },
    { flags: ["--tracks"], dest: "tracks", metavar: "FILE", help: "Upload track data file (e.g., robot_position.jsonl). Requires --remote-path." },
    { flags: ["--remote-path"], dest: "remote_path", metavar: "PATH", help: "Remote path for track (e.g., 'namespace/project/exp/robot/position')" },
    { flags: ["-p", "--pref", "--prefix", "--proj", "--project"], dest: "project", metavar: "PROJECT", help: "Filter experiments by prefix pattern (supports glob: 'tom/*/exp*', 'alice/project-?/baseline')" },
    { flags: ["-t", "--target"], dest: "target", metavar: "TARGET", help: "Target prefix/directory on server where experiments will be uploaded (e.g., 'alice/shared-project')" },
    { flags: ["--skip-logs"], dest: "skip_logs", boolean: true, help: "Don't upload logs" },
    { flags: ["--skip-metrics"], dest: "skip_metrics", boolean: true, help: "Don't upload metrics" },
    { flags: ["--skip-files"], dest: "skip_files", boolean: true, help: "Don't upload files" },
    { flags: ["--skip-params"], dest: "skip_params", boolean: true, help: "Don't upload parameters" },
    { flags: ["--dry-run"], dest: "dry_run", boolean: true, help: "Show what would be uploaded without uploading" },
    { flags: ["--strict"], dest: "strict", boolean: true, help: "Fail on any validation error (default: skip invalid data)" },
    { flags: ["-v", "--verbose"], dest: "verbose", boolean: true, help: "Show detailed progress" },
    { flags: ["--batch-size"], dest: "batch_size", metavar: "N", help: "Batch size for logs/metrics (default: 100)" },
    { flags: ["--resume"], dest: "resume", boolean: true, help: "Resume previous interrupted upload" },
    { flags: ["--state-file"], dest: "state_file", metavar: "FILE", help: "Path to state file for resume (default: .dash-upload-state.json)" },
  ],
};

// ── discovery ────────────────────────────────────────────────────────────────

export interface ExperimentInfo {
  project: string;
  experiment: string;
  /** Absolute directory holding experiment.json. */
  dir: string;
  /** Location under the .dash root — what LocalStorage reads from. */
  storagePrefix: string;
  /** Prefix declared in experiment.json — what the server is told. */
  declaredPrefix?: string;
  hasLogs: boolean;
  hasParams: boolean;
  metrics: LocalMetric[];
  fileCount: number;
  estimatedSize: number;
}

/** Every directory under `root` that contains an experiment.json. */
function findExperimentDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 24) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (existsSync(path.join(child, "experiment.json"))) out.push(child);
      // Descend regardless: `.dash/owner/project/folder/exp` nests experiments
      // under plain folders, and an experiment may sit below another one.
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out.sort();
}

/**
 * Match the three filter modes argparse's `-p` carried in the Python CLI:
 * a glob is fnmatched against the path under the root, a value with a slash is
 * a path prefix, and a bare word is an exact project-name match.
 */
export function matchesFilter(relPath: string, projectName: string, filter: string): boolean {
  if (hasWildcard(filter)) return fnmatch(relPath, filter);
  if (filter.includes("/")) return relPath === filter || relPath.startsWith(`${filter}/`);
  return projectName === filter;
}

export function discoverExperiments(
  storage: LocalStorage,
  projectFilter?: string,
  experimentFilter?: string,
): ExperimentInfo[] {
  const root = storage.rootPath;
  const found: ExperimentInfo[] = [];

  for (const dir of findExperimentDirs(root)) {
    const relPath = path.relative(root, dir).split(path.sep).join("/");
    if (!relPath || relPath.startsWith("..")) continue;

    let declaredPrefix: string | undefined;
    try {
      const meta = parseJson<any>(readFileSync(path.join(dir, "experiment.json"), "utf8"));
      if (typeof meta?.prefix === "string" && meta.prefix.trim()) declaredPrefix = meta.prefix;
    } catch {
      // Unreadable metadata is a validation error, not a discovery one.
    }

    const relParts = relPath.split("/");
    let project: string;
    let experiment: string;
    if (declaredPrefix) {
      const parts = declaredPrefix.replace(/^\/+|\/+$/g, "").split("/");
      if (parts.length < 3) continue; // needs at least owner/project/experiment
      project = parts[1];
      experiment = parts[parts.length - 1];
    } else {
      if (relParts.length < 2) continue;
      experiment = relParts[relParts.length - 1];
      project = relParts[relParts.length - 2];
    }

    if (projectFilter && !matchesFilter(relPath, project, projectFilter)) continue;
    if (experimentFilter && experiment !== experimentFilter) continue;

    const info: ExperimentInfo = {
      project,
      experiment,
      dir,
      storagePrefix: relPath,
      declaredPrefix,
      hasParams: existsSync(path.join(dir, "parameters.json")),
      hasLogs: existsSync(path.join(dir, "logs", "logs.jsonl")),
      metrics: storage.listMetrics(relPath),
      fileCount: 0,
      estimatedSize: 0,
    };

    const records = storage.listFiles(relPath);
    info.fileCount = records.length;
    for (const record of records) {
      try {
        info.estimatedSize += statSync(storage.filePath(relPath, record)).size;
      } catch {
        // Counted by validation as a missing file.
      }
    }

    found.push(info);
  }

  return found;
}

// ── validation ───────────────────────────────────────────────────────────────

export interface ValidationResult {
  isValid: boolean;
  warnings: string[];
  errors: string[];
  metadata?: Record<string, any>;
  parameters?: Record<string, unknown>;
}

export function validateExperiment(
  storage: LocalStorage,
  info: ExperimentInfo,
  strict: boolean,
): ValidationResult {
  const result: ValidationResult = { isValid: true, warnings: [], errors: [] };

  const expJson = path.join(info.dir, "experiment.json");
  if (!existsSync(expJson)) {
    return { ...result, isValid: false, errors: ["Missing experiment.json"] };
  }
  try {
    const metadata = parseJson<any>(readFileSync(expJson, "utf8"));
    if (!metadata || typeof metadata !== "object" || !("name" in metadata) || !("project" in metadata)) {
      return {
        ...result,
        isValid: false,
        errors: ["experiment.json missing required fields (name, project)"],
      };
    }
    result.metadata = metadata;
  } catch (e) {
    return { ...result, isValid: false, errors: [`Invalid JSON in experiment.json: ${(e as Error).message}`] };
  }

  if (info.hasParams) {
    const params = storage.readParameters(info.storagePrefix);
    if (params === null) result.warnings.push("parameters.json is not a dict (will skip)");
    else result.parameters = params;
  }

  if (info.hasLogs) {
    const invalid = countInvalidLines(path.join(info.dir, "logs", "logs.jsonl"), (o) => "message" in o);
    if (invalid.count > 0) {
      result.warnings.push(
        `logs.jsonl has ${invalid.count} invalid lines (e.g., [${invalid.preview.join(", ")}]...) - will skip these`,
      );
    }
  }

  for (const metric of info.metrics) {
    const invalid = countInvalidLines(metric.dataFile, (o) => "data" in o);
    if (invalid.count > 0) {
      result.warnings.push(
        `metric '${metric.name}' has ${invalid.count} invalid lines (e.g., [${invalid.preview.join(", ")}]...) - will skip these`,
      );
    }
  }

  const missing = storage
    .listFiles(info.storagePrefix)
    .filter((f) => !existsSync(storage.filePath(info.storagePrefix, f)))
    .map((f) => f.filename);
  if (missing.length > 0) {
    result.warnings.push(
      `${missing.length} files referenced in metadata but missing on disk ` +
        `(e.g., [${missing.slice(0, 3).join(", ")}]...) - will skip these`,
    );
  }

  if (strict && result.warnings.length > 0) {
    result.errors.push(...result.warnings);
    result.warnings = [];
    result.isValid = false;
  }
  return result;
}

function countInvalidLines(
  file: string,
  isValid: (o: Record<string, unknown>) => boolean,
): { count: number; preview: number[] } {
  const bad: number[] = [];
  if (!existsSync(file)) return { count: 0, preview: [] };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { count: 0, preview: [] };
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || !isValid(parsed)) bad.push(i + 1);
    } catch {
      bad.push(i + 1);
    }
  });
  return { count: bad.length, preview: bad.slice(0, 5) };
}

// ── resume state ─────────────────────────────────────────────────────────────

interface TransferState {
  dash_root: string;
  remote_url: string;
  completed_experiments: string[];
  failed_experiments: string[];
  in_progress_experiment: string | null;
  timestamp: string | null;
}

const loadState = (file: string): TransferState | null => {
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (typeof data?.dash_root !== "string" || typeof data?.remote_url !== "string") return null;
    return {
      dash_root: data.dash_root,
      remote_url: data.remote_url,
      completed_experiments: data.completed_experiments ?? [],
      failed_experiments: data.failed_experiments ?? [],
      in_progress_experiment: data.in_progress_experiment ?? null,
      timestamp: data.timestamp ?? null,
    };
  } catch {
    return null;
  }
};

const saveState = (file: string, state: TransferState): void => {
  state.timestamp = new Date().toISOString();
  writeFileSync(file, JSON.stringify(state, null, 2));
};

// ── uploading one experiment ─────────────────────────────────────────────────

export interface UploadResult {
  experiment: string;
  success: boolean;
  uploaded: Record<string, number>;
  failed: Record<string, string[]>;
  errors: string[];
  bytesUploaded: number;
}

interface UploaderOptions {
  batchSize: number;
  skipLogs: boolean;
  skipMetrics: boolean;
  skipFiles: boolean;
  skipParams: boolean;
  verbose: boolean;
  targetPrefix?: string;
}

async function uploadExperiment(
  storage: LocalStorage,
  client: RemoteClient,
  info: ExperimentInfo,
  validation: ValidationResult,
  opts: UploaderOptions,
): Promise<UploadResult> {
  const result: UploadResult = {
    experiment: `${info.project}/${info.experiment}`,
    success: false,
    uploaded: {},
    failed: {},
    errors: [],
    bytesUploaded: 0,
  };
  const note = (line: string): void => {
    if (opts.verbose) console.log(line);
  };

  try {
    const meta = validation.metadata ?? {};

    // --target behaves like an scp destination directory: the experiment name
    // is appended to it, and its second segment names the project.
    let fullPrefix: string;
    let targetProject: string;
    if (opts.targetPrefix) {
      fullPrefix = `${opts.targetPrefix.replace(/\/+$/, "")}/${info.experiment}`;
      const parts = opts.targetPrefix.replace(/^\/+|\/+$/g, "").split("/");
      targetProject = parts.length >= 2 ? parts[1] : info.project;
    } else if (info.declaredPrefix) {
      fullPrefix = info.declaredPrefix;
      targetProject = info.project;
    } else {
      fullPrefix = info.storagePrefix;
      targetProject = info.project;
    }

    note(dim("  Creating experiment..."));
    const response = await client.createOrUpdateExperiment({
      project: targetProject,
      name: info.experiment,
      description: meta.description ?? null,
      tags: meta.tags ?? null,
      bindrs: meta.bindrs ?? null,
      prefix: fullPrefix,
      writeProtected: meta.write_protected === true,
      metadata: meta.metadata ?? null,
    });
    const experimentId = String(response?.experiment?.id ?? response?.id ?? "");
    if (!experimentId) throw new Error("Server did not return an experiment id");
    note(`  ${green("✓")} Created experiment (id: ${experimentId})`);

    if (!opts.skipParams && validation.parameters) {
      const params = validation.parameters;
      await client.setParameters(experimentId, params);
      result.uploaded.params = Object.keys(params).length;
      result.bytesUploaded += Buffer.byteLength(JSON.stringify(params), "utf8");
      note(`  ${green("✓")} Uploaded ${result.uploaded.params} parameters`);
    }

    if (!opts.skipLogs && info.hasLogs) {
      try {
        const { uploaded, skipped, bytes } = await uploadLogs(storage, client, experimentId, info, opts);
        result.uploaded.logs = uploaded;
        result.bytesUploaded += bytes;
        note(
          `  ${green("✓")} Uploaded ${uploaded} log entries` +
            (skipped > 0 ? ` (skipped ${skipped} invalid)` : ""),
        );
      } catch (e) {
        (result.failed.logs ??= []).push((e as Error).message);
      }
    }

    if (!opts.skipMetrics && info.metrics.length > 0) {
      const outcomes = await runPool(info.metrics, METRIC_WORKERS, async (metric) => {
        const { points, skipped, bytes } = storage.readMetricPoints(metric);
        for (let i = 0; i < points.length; i += opts.batchSize) {
          await client.appendBatchToMetric(experimentId, metric.name, points.slice(i, i + opts.batchSize));
        }
        return { uploaded: points.length, skipped, bytes };
      });

      let ok = 0;
      outcomes.forEach((outcome, i) => {
        const metric = info.metrics[i];
        if (outcome.error) {
          (result.failed.metrics ??= []).push(`${metric.name}: ${outcome.error.message}`);
          note(`  ${red("✗")} Failed to upload '${metric.name}': ${outcome.error.message}`);
          return;
        }
        ok++;
        result.bytesUploaded += outcome.value!.bytes;
        note(
          `  ${green("✓")} Uploaded ${outcome.value!.uploaded} data points for '${metric.name}'` +
            (outcome.value!.skipped > 0 ? ` (skipped ${outcome.value!.skipped} invalid)` : ""),
        );
      });
      result.uploaded.metrics = ok;
    }

    if (!opts.skipFiles && info.fileCount > 0) {
      const uploadedFiles = await uploadFiles(storage, client, experimentId, info, result, opts);
      result.uploaded.files = uploadedFiles;
    }

    // A section that failed is a failed experiment: keeping success here is
    // what let the Python CLI delete its resume state after losing metrics.
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
    if (opts.verbose) console.log(`  ${red(`✗ Error: ${(e as Error).message}`)}`);
  }

  return result;
}

async function uploadLogs(
  storage: LocalStorage,
  client: RemoteClient,
  experimentId: string,
  info: ExperimentInfo,
  opts: UploaderOptions,
): Promise<{ uploaded: number; skipped: number; bytes: number }> {
  const file = path.join(info.dir, "logs", "logs.jsonl");
  const lines = readFileSync(file, "utf8").split("\n");

  let batch: Record<string, unknown>[] = [];
  let uploaded = 0;
  let skipped = 0;
  let bytes = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await client.createLogEntries(experimentId, batch);
    uploaded += batch.length;
    batch = [];
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (entry === null || typeof entry !== "object" || !("message" in entry)) {
      skipped++;
      continue;
    }
    const apiLog: Record<string, unknown> = {
      timestamp: entry.timestamp ?? null,
      level: entry.level ?? "info",
      message: entry.message,
    };
    if ("metadata" in entry) apiLog.metadata = entry.metadata;
    batch.push(apiLog);
    bytes += Buffer.byteLength(line, "utf8");
    if (batch.length >= opts.batchSize) await flush();
  }
  await flush();
  return { uploaded, skipped, bytes };
}

async function uploadFiles(
  storage: LocalStorage,
  client: RemoteClient,
  experimentId: string,
  info: ExperimentInfo,
  result: UploadResult,
  opts: UploaderOptions,
): Promise<number> {
  let uploaded = 0;
  let records;
  try {
    records = storage.listFiles(info.storagePrefix);
  } catch (e) {
    (result.failed.files ??= []).push((e as Error).message);
    return 0;
  }
  if (opts.verbose) {
    console.log(dim(`  Found ${records.length} files to upload from prefix: ${info.storagePrefix}`));
  }

  for (const record of records) {
    const source = storage.filePath(info.storagePrefix, record);
    try {
      if (!existsSync(source)) throw new Error(`missing on disk: ${source}`);
      await client.uploadFile({
        experimentId,
        filePath: source,
        prefix: record.path ?? "",
        filename: record.filename,
        description: record.description,
        tags: record.tags,
        metadata: record.metadata,
        checksum: record.checksum,
        contentType: record.contentType,
        sizeBytes: record.sizeBytes,
      });
      uploaded++;
      result.bytesUploaded += record.sizeBytes ?? 0;
      if (opts.verbose) {
        console.log(`    ${green("✓")} ${record.filename} (${formatBytes(record.sizeBytes ?? 0)})`);
      }
    } catch (e) {
      (result.failed.files ??= []).push(`${record.filename}: ${(e as Error).message}`);
    }
  }
  return uploaded;
}

// ── track upload ─────────────────────────────────────────────────────────────

async function uploadTrack(args: ParsedArgs): Promise<number> {
  const ctx = resolveContext(args);
  const localFile = String(args.tracks);
  const remotePath = typeof args.remote_path === "string" ? args.remote_path : "";

  if (!remotePath) {
    console.error(`${red("Error:")} Both --tracks and --remote-path are required for track upload`);
    console.error("Usage: ml-dash upload --tracks <local-file> --remote-path namespace/project/exp/topic");
    return 1;
  }
  if (!existsSync(localFile)) {
    console.error(`${red("Error:")} File not found: ${localFile}`);
    return 1;
  }
  const parts = remotePath.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 4) {
    console.error(`${red("Error:")} Remote path must be: 'namespace/project/experiment/topic'`);
    console.error("Example: geyang/project/exp1/robot/position");
    return 1;
  }
  if (!ctx.apiKey) {
    console.error(`${red("Error:")} ${notAuthenticatedMessage(ctx)}`);
    return 1;
  }

  const [namespace, project, experimentName] = parts;
  const topic = parts.slice(3).join("/");

  console.log(bold("Uploading track data..."));
  console.log(`  Local file: ${localFile}`);
  console.log(`  Namespace: ${namespace}`);
  console.log(`  Project: ${project}`);
  console.log(`  Experiment: ${experimentName}`);
  console.log(`  Topic: ${topic}`);

  const client = makeClient(ctx, namespace);
  try {
    const experiment = await client.getExperimentGraphql(project, experimentName, namespace);
    if (!experiment) {
      console.error(`${red("Error:")} Experiment '${experimentName}' not found in project '${project}'`);
      return 1;
    }

    console.log(`\n${cyan("Reading local file...")}`);
    const entries: unknown[] = [];
    readFileSync(localFile, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!line.trim()) return;
        try {
          const entry = JSON.parse(line);
          if (!entry || typeof entry !== "object" || !("timestamp" in entry)) {
            console.log(`${yellow("Warning:")} Line ${i + 1} missing timestamp, skipping`);
            return;
          }
          entries.push(entry);
        } catch (e) {
          console.log(`${yellow("Warning:")} Line ${i + 1} invalid JSON: ${(e as Error).message}`);
        }
      });

    if (entries.length === 0) {
      console.error(`${red("Error:")} No valid entries found in file`);
      return 1;
    }
    console.log(`  Found ${entries.length} entries`);

    console.log(`\n${cyan("Uploading to server...")}`);
    const experimentId = String(experiment.id);
    let total = 0;
    for (let i = 0; i < entries.length; i += 1000) {
      const batch = entries.slice(i, i + 1000);
      await client.appendBatchToTrack(experimentId, topic, batch);
      total += batch.length;
      console.log(`  Uploaded ${total}/${entries.length} entries`);
    }

    console.log(`\n${green("✓ Track data uploaded successfully")}`);
    console.log(`  Total entries: ${total}`);
    console.log(`  Topic: ${topic}`);
    console.log(`  Experiment: ${namespace}/${project}/${experimentName}`);
    return 0;
  } catch (e) {
    console.error(`${red("Error uploading track data:")} ${(e as Error).message}`);
    return 1;
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

export async function run(args: ParsedArgs): Promise<number> {
  if (args.tracks) return uploadTrack(args);

  const ctx = resolveContext(args);
  const batchSize = Number.parseInt(String(args.batch_size ?? "100"), 10);
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    console.error(`${red("Error:")} --batch-size must be a positive integer`);
    return 1;
  }

  const dashRoot = path.resolve(String(args.path ?? "./.dash"));
  if (!existsSync(dashRoot)) {
    console.error(`${red("Error:")} Local storage path does not exist: ${args.path}`);
    return 1;
  }
  if (!ctx.apiKey) {
    console.error(`${red("Error:")} ${notAuthenticatedMessage(ctx)}`);
    return 1;
  }

  const stateFile = path.resolve(String(args.state_file ?? ".dash-upload-state.json"));
  let state: TransferState | null = null;
  if (args.resume) {
    state = loadState(stateFile);
    if (!state) {
      console.log(yellow("No previous upload state found. Starting fresh upload."));
    } else if (state.dash_root !== dashRoot) {
      console.log(`${yellow("Warning:")} State file local path doesn't match. Starting fresh upload.`);
      state = null;
    } else if (state.remote_url !== ctx.remoteUrl) {
      console.log(`${yellow("Warning:")} State file remote URL doesn't match. Starting fresh upload.`);
      state = null;
    } else {
      console.log(green(`Resuming previous upload from ${state.timestamp}`));
      console.log(`  Already completed: ${state.completed_experiments.length} experiments`);
      console.log(`  Failed: ${state.failed_experiments.length} experiments`);
    }
  }
  if (!state) {
    state = {
      dash_root: dashRoot,
      remote_url: ctx.remoteUrl,
      completed_experiments: [],
      failed_experiments: [],
      in_progress_experiment: null,
      timestamp: null,
    };
  }

  const storage = new LocalStorage(dashRoot);
  console.log(`${bold("Scanning local storage:")} ${dashRoot}`);
  const projectFilter = typeof args.project === "string" ? args.project : undefined;
  let experiments = discoverExperiments(storage, projectFilter);

  if (experiments.length === 0) {
    console.log(
      projectFilter
        ? `${yellow("No experiments found matching pattern:")} ${projectFilter}`
        : yellow("No experiments found in local storage"),
    );
    return 1;
  }

  if (args.resume && state.completed_experiments.length > 0) {
    const before = experiments.length;
    const done = new Set(state.completed_experiments);
    experiments = experiments.filter((e) => !done.has(`${e.project}/${e.experiment}`));
    const skipped = before - experiments.length;
    if (skipped > 0) console.log(dim(`Skipping ${skipped} already completed experiment(s)`));
  }

  console.log(green(`Found ${experiments.length} experiment(s) to upload`));

  if (args.verbose || args.dry_run) {
    console.log(`\n${bold("Discovered experiments:")}`);
    for (const exp of experiments) {
      const parts: string[] = [];
      if (exp.hasLogs) parts.push("logs");
      if (exp.hasParams) parts.push("params");
      if (exp.metrics.length) parts.push(`${exp.metrics.length} metrics`);
      if (exp.fileCount) parts.push(`${exp.fileCount} files (${formatBytes(exp.estimatedSize)})`);
      const details = parts.length ? parts.join(", ") : "metadata only";
      console.log(`  ${cyan("•")} ${exp.project}/${exp.experiment} ${dim(`(${details})`)}`);
    }
  }

  if (args.dry_run) {
    console.log(`\n${yellow(bold("DRY RUN"))} - No data will be uploaded`);
    console.log("Run without --dry-run to proceed with upload.");
    return 0;
  }

  console.log(`\n${bold("Validating experiments...")}`);
  const validations = new Map<string, ValidationResult>();
  const valid: ExperimentInfo[] = [];
  let invalidCount = 0;

  for (const exp of experiments) {
    const key = `${exp.project}/${exp.experiment}`;
    const validation = validateExperiment(storage, exp, args.strict === true);
    validations.set(key, validation);
    if (validation.isValid) valid.push(exp);
    else invalidCount++;

    if (validation.errors.length > 0) {
      console.log(`  ${red("✗")} ${key}:`);
      for (const error of validation.errors) console.log(`      ${red(error)}`);
    } else if (args.verbose && validation.warnings.length > 0) {
      console.log(`  ${yellow("⚠")} ${key}:`);
      for (const warning of validation.warnings) console.log(`      ${yellow(warning)}`);
    }
  }

  if (invalidCount > 0) {
    console.log(`\n${yellow(`${invalidCount} experiment(s) failed validation and will be skipped`)}`);
    if (args.strict) {
      console.error(red("Error: Validation failed in --strict mode"));
      return 1;
    }
  }
  if (valid.length === 0) {
    console.error(red("Error: No valid experiments to upload"));
    return 1;
  }
  console.log(green(`${valid.length} experiment(s) ready to upload`));

  const target = typeof args.target === "string" ? args.target : undefined;
  let namespace: string | undefined;
  if (target) namespace = target.replace(/^\/+|\/+$/g, "").split("/")[0];
  if (!namespace) {
    const first = valid[0].declaredPrefix ?? valid[0].storagePrefix;
    namespace = first.replace(/^\/+/, "").split("/")[0];
  }

  const client = makeClient(ctx, namespace);
  const opts: UploaderOptions = {
    batchSize,
    skipLogs: args.skip_logs === true,
    skipMetrics: args.skip_metrics === true,
    skipFiles: args.skip_files === true,
    skipParams: args.skip_params === true,
    verbose: args.verbose === true,
    targetPrefix: target,
  };

  console.log(`\n${bold("Uploading to:")} ${ctx.remoteUrl}`);
  if (target) console.log(`${bold("Target prefix:")} ${target}`);

  const started = Date.now();
  const results: UploadResult[] = [];

  for (let i = 0; i < valid.length; i++) {
    const exp = valid[i];
    const key = `${exp.project}/${exp.experiment}`;
    console.log(`${cyan(`[${i + 1}/${valid.length}] ${key}`)}`);

    state.in_progress_experiment = key;
    saveState(stateFile, state);

    const result = await uploadExperiment(storage, client, exp, validations.get(key)!, opts);
    results.push(result);

    state.in_progress_experiment = null;
    if (result.success) state.completed_experiments.push(key);
    else state.failed_experiments.push(key);
    saveState(stateFile, state);

    if (!args.verbose) {
      if (result.success) {
        const parts: string[] = [];
        if (result.uploaded.params) parts.push(`${result.uploaded.params} params`);
        if (result.uploaded.logs) parts.push(`${result.uploaded.logs} logs`);
        if (result.uploaded.metrics) parts.push(`${result.uploaded.metrics} metrics`);
        if (result.uploaded.files) parts.push(`${result.uploaded.files} files`);
        console.log(`  ${green("✓")} Uploaded (${parts.length ? parts.join(", ") : "metadata only"})`);
      } else {
        console.log(`  ${red("✗")} Failed`);
        for (const error of result.errors.slice(0, 3)) console.log(`      ${red(error)}`);
      }
    }
  }

  const elapsed = (Date.now() - started) / 1000;
  const totalBytes = results.reduce((n, r) => n + r.bytesUploaded, 0);
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  const summary: string[][] = [
    ["Successful", `${successful.length}/${results.length}`],
  ];
  if (failed.length) summary.push(["Failed", `${failed.length}/${results.length}`]);
  summary.push(["Total Time", `${elapsed.toFixed(2)}s`]);
  if (totalBytes > 0 && elapsed > 0) {
    summary.push(["Avg Speed", `${formatBytes(totalBytes / elapsed)}/s`]);
  }
  console.log();
  console.log(
    renderTable(
      [{ header: "Status" }, { header: "Count", align: "right" }],
      summary,
      { title: "Upload Summary" },
    ),
  );

  if (failed.length > 0) {
    console.log(`\n${bold(red("Failed Experiments:"))}`);
    for (const result of failed) {
      console.log(`  ${red("✗")} ${result.experiment}`);
      for (const error of result.errors) console.log(`      ${dim(error)}`);
      for (const [section, messages] of Object.entries(result.failed)) {
        for (const message of messages) console.log(`      ${dim(`${section}: ${message}`)}`);
      }
    }
  }

  const totals = {
    Logs: results.reduce((n, r) => n + (r.uploaded.logs ?? 0), 0),
    Metrics: results.reduce((n, r) => n + (r.uploaded.metrics ?? 0), 0),
    Files: results.reduce((n, r) => n + (r.uploaded.files ?? 0), 0),
  };
  const unit: Record<string, string> = { Logs: "entries", Metrics: "metrics", Files: "files" };
  const dataRows = Object.entries(totals)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => [type, `${n} ${unit[type]}`]);
  if (dataRows.length > 0) {
    console.log();
    console.log(
      renderTable(
        [{ header: "Type" }, { header: "Count", align: "right" }],
        dataRows,
        { title: "Data Uploaded" },
      ),
    );
  }

  if (failed.length === 0) {
    if (existsSync(stateFile)) unlinkSync(stateFile);
    console.log(`\n${dim("Upload complete. State file removed.")}`);
  } else {
    console.log(`\n${yellow(`State saved to ${stateFile}. Use --resume to retry failed uploads.`)}`);
  }

  return failed.length === 0 ? 0 : 1;
}
