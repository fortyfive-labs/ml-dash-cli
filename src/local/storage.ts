/**
 * The `.dash` directory on disk — the same tree the Python SDK writes.
 *
 *   .dash/{owner}/{project}/{folders…}/{experiment}/
 *     experiment.json
 *     parameters.json
 *     logs/logs.jsonl          + .log_sequence
 *     metrics/{name}/data.jsonl + metadata.json   ← current layout
 *     metrics/{name}.jsonl                        ← legacy layout
 *     files/{path}/{file_id}/{filename}
 *     files/.files_metadata.json
 *
 * Both metric layouts are read. The Python SDK still writes the legacy flat
 * form from `write_metric_data`, while its CLI's discovery only ever looked for
 * the `metrics/<name>/data.jsonl` layout — so an experiment recorded through that path uploaded
 * as "successful" with none of its metrics. Reading both is a deliberate
 * divergence from the Python CLI, recorded in docs/PORTING.md.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { literal, resolveUnderRoot, type PathPart } from "./safe-path.js";

export const FILES_METADATA_FILENAME = ".files_metadata.json";

export const utcNowIso = (): string => new Date().toISOString().replace(/Z$/, "Z");

/** Local-mode ID, matching the Python `(ms << 12) | rand12` shape. */
export function generateSnowflakeId(): string {
  const ms = BigInt(Date.now());
  const rand = BigInt(Math.floor(Math.random() * 4096));
  return ((ms << 12n) | rand).toString();
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("error", reject)
      .on("data", (c) => hash.update(c))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export interface LocalFileRecord {
  id: string;
  experimentId: string;
  path: string;
  filename: string;
  description: string | null;
  tags: string[];
  bindrs: string[];
  contentType: string;
  sizeBytes: number;
  checksum: string;
  metadata: Record<string, unknown> | null;
  uploadedAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** One metric found on disk, in whichever layout it was written. */
export interface LocalMetric {
  name: string;
  layout: "directory" | "flat";
  dataFile: string;
}

export class LocalStorage {
  readonly rootPath: string;

  constructor(rootPath: string) {
    const resolved = path.resolve(rootPath);
    mkdirSync(resolved, { recursive: true });
    // The root is the one path the user picked deliberately, so following its
    // own links is what they asked for; everything below it is checked
    // against this canonical form.
    this.rootPath = realpathSync(resolved);
  }

  /**
   * The single boundary: every path this class touches is built here, from
   * the root down, with the server-supplied parts and the literal ones
   * checked alike. A derived directory is never treated as a new root.
   */
  private target(parts: PathPart[], mode: "read" | "write" = "write"): string {
    return resolveUnderRoot(this.rootPath, parts, mode);
  }

  private static prefixPart = (prefix: string): PathPart => ({
    label: "experiment prefix",
    value: prefix,
    nested: true,
  });

  /**
   * Experiment directory for a prefix of the form owner/project/folders…/name.
   *
   * Read mode: callers outside this class use it to look, and `upload` has to
   * keep working on a tree where the user symlinked their own data. Every
   * write below goes through `target(…, "write")` instead.
   */
  experimentDir(prefix: string): string {
    return this.target([LocalStorage.prefixPart(prefix)], "read");
  }

  /** Same directory, as a write target. */
  private experimentWriteDir(prefix: string): string {
    return this.target([LocalStorage.prefixPart(prefix)]);
  }

  // ── experiment metadata ────────────────────────────────────────────────────

  /**
   * Create or merge experiment.json. Existing files are merged, never
   * clobbered, so a download into a populated tree does not discard fields the
   * server did not return.
   */
  createExperiment(args: {
    project: string;
    prefix: string;
    description?: string | null;
    tags?: string[] | null;
    bindrs?: string[] | null;
    metadata?: Record<string, unknown> | null;
  }): string {
    const prefixClean = args.prefix.replace(/\/+$/, "");
    const dir = this.experimentWriteDir(prefixClean);
    mkdirSync(dir, { recursive: true });
    for (const sub of ["logs", "metrics", "files"]) {
      mkdirSync(this.target([LocalStorage.prefixPart(prefixClean), literal(sub)]), { recursive: true });
    }

    const name = prefixClean.split("/").pop()!;
    const file = this.target([LocalStorage.prefixPart(prefixClean), literal("experiment.json")]);

    if (!existsSync(file)) {
      writeFileSync(
        file,
        JSON.stringify({
          name,
          project: args.project,
          description: args.description ?? null,
          tags: args.tags ?? [],
          bindrs: args.bindrs ?? [],
          prefix: args.prefix,
          metadata: args.metadata ?? null,
          created_at: utcNowIso(),
          write_protected: false,
        }),
      );
      return dir;
    }

    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // Corrupt or truncated — rewrite rather than fail the whole download.
      writeFileSync(
        file,
        JSON.stringify({
          name,
          project: args.project,
          description: args.description ?? null,
          tags: args.tags ?? [],
          bindrs: args.bindrs ?? [],
          prefix: args.prefix,
          metadata: args.metadata ?? null,
          created_at: utcNowIso(),
          write_protected: false,
        }),
      );
      return dir;
    }

    if (args.description != null) existing.description = args.description;
    if (args.tags != null) existing.tags = args.tags;
    if (args.bindrs != null) existing.bindrs = args.bindrs;
    if (args.prefix != null) existing.prefix = args.prefix;
    if (args.metadata != null) existing.metadata = args.metadata;
    existing.updated_at = utcNowIso();
    writeFileSync(file, JSON.stringify(existing));
    return dir;
  }

  readExperiment(prefix: string): Record<string, any> | null {
    const file = this.target([LocalStorage.prefixPart(prefix), literal("experiment.json")], "read");
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  // ── parameters ─────────────────────────────────────────────────────────────

  /** Merge into parameters.json, bumping `version` the way the SDK does. */
  writeParameters(prefix: string, data: Record<string, unknown>): void {
    mkdirSync(this.experimentWriteDir(prefix), { recursive: true });
    const file = this.target([LocalStorage.prefixPart(prefix), literal("parameters.json")]);

    let merged: Record<string, unknown> = {};
    let version = 1;
    if (existsSync(file)) {
      try {
        const doc = JSON.parse(readFileSync(file, "utf8"));
        if (doc && typeof doc === "object") {
          merged = (doc.data && typeof doc.data === "object" ? doc.data : doc) as Record<string, unknown>;
          version = typeof doc.version === "number" ? doc.version + 1 : 2;
        }
      } catch {
        merged = {};
      }
    }
    writeFileSync(
      file,
      JSON.stringify({ version, data: { ...merged, ...data }, updatedAt: utcNowIso() }),
    );
  }

  /** Read parameters, accepting both the versioned and the bare-dict shapes. */
  readParameters(prefix: string): Record<string, unknown> | null {
    const file = this.target([LocalStorage.prefixPart(prefix), literal("parameters.json")], "read");
    if (!existsSync(file)) return null;
    try {
      const doc = JSON.parse(readFileSync(file, "utf8"));
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
      if ("data" in doc) {
        return doc.data && typeof doc.data === "object" ? doc.data : null;
      }
      return doc;
    } catch {
      return null;
    }
  }

  // ── logs ───────────────────────────────────────────────────────────────────

  /**
   * Append log entries, continuing the `.log_sequence` counter so downloaded
   * logs interleave correctly with anything already recorded locally.
   */
  appendLogs(
    prefix: string,
    entries: { message: string; level?: string; timestamp?: string; metadata?: unknown }[],
  ): number {
    if (entries.length === 0) return 0;
    const logsDir = this.target([LocalStorage.prefixPart(prefix), literal("logs")]);
    mkdirSync(logsDir, { recursive: true });
    const logsFile = this.target([LocalStorage.prefixPart(prefix), literal("logs"), literal("logs.jsonl")]);
    const seqFile = this.target([LocalStorage.prefixPart(prefix), literal("logs"), literal(".log_sequence")]);

    let sequence = 0;
    if (existsSync(seqFile)) {
      const parsed = Number.parseInt(readFileSync(seqFile, "utf8").trim(), 10);
      if (Number.isFinite(parsed)) sequence = parsed;
    }

    let out = "";
    for (const e of entries) {
      const record: Record<string, unknown> = {
        sequenceNumber: sequence++,
        timestamp: e.timestamp ?? "",
        level: e.level ?? "info",
        message: e.message,
      };
      if (e.metadata) record.metadata = e.metadata;
      out += JSON.stringify(record) + "\n";
    }
    appendFileSync(logsFile, out);
    writeFileSync(seqFile, String(sequence));
    return entries.length;
  }

  readLogs(prefix: string): Record<string, any>[] {
    const file = this.target([LocalStorage.prefixPart(prefix), literal("logs"), literal("logs.jsonl")], "read");
    if (!existsSync(file)) return [];
    const out: Record<string, any>[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skipped, as the Python uploader skipped unparseable lines */
      }
    }
    return out;
  }

  // ── metrics ────────────────────────────────────────────────────────────────

  /**
   * Every metric in the experiment, from both layouts.
   *
   * A name present in both is reported once, from the directory layout, which
   * is the one the current SDK writes and the one that carries an index.
   */
  listMetrics(prefix: string): LocalMetric[] {
    const metricsDir = this.target([LocalStorage.prefixPart(prefix), literal("metrics")], "read");
    if (!existsSync(metricsDir)) return [];

    const found = new Map<string, LocalMetric>();
    for (const entry of readdirSync(metricsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const dataFile = path.join(metricsDir, entry.name, "data.jsonl");
        if (existsSync(dataFile)) {
          found.set(entry.name, { name: entry.name, layout: "directory", dataFile });
        }
      }
    }
    for (const entry of readdirSync(metricsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const name = entry.name.slice(0, -".jsonl".length);
        if (!found.has(name)) {
          found.set(name, { name, layout: "flat", dataFile: path.join(metricsDir, entry.name) });
        }
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Read one metric's data points as the values the server wants.
   *
   * Both layouts store one JSON object per line with the point under `data`;
   * the directory layout adds `index` and `createdAt`. Lines without `data`
   * are skipped and counted, never uploaded as `undefined`.
   */
  readMetricPoints(metric: LocalMetric): { points: unknown[]; skipped: number; bytes: number } {
    const points: unknown[] = [];
    let skipped = 0;
    let bytes = 0;
    if (!existsSync(metric.dataFile)) return { points, skipped, bytes };

    for (const line of readFileSync(metric.dataFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      bytes += Buffer.byteLength(line, "utf8");
      try {
        const parsed = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object" || !("data" in parsed)) {
          skipped++;
          continue;
        }
        points.push(parsed.data);
      } catch {
        skipped++;
      }
    }
    return { points, skipped, bytes };
  }

  /** Append points in the directory layout, maintaining index and counts. */
  appendBatchToMetric(prefix: string, metricName: string | null, dataPoints: unknown[]): void {
    const dirName = metricName === null ? "None" : String(metricName);
    // A nested name ('train/loss') keeps nesting; '..' in one does not. Every
    // part, including 'metrics' and the two filenames, is checked from the
    // root — `metrics` being a link out of the tree is the case a check
    // anchored at the metrics directory could not see.
    const metricParts: PathPart[] = [
      LocalStorage.prefixPart(prefix),
      literal("metrics"),
      { label: "metric name", value: dirName, nested: true },
    ];
    const metricDir = this.target(metricParts);
    mkdirSync(metricDir, { recursive: true });

    const dataFile = this.target([...metricParts, literal("data.jsonl")]);
    const metadataFile = this.target([...metricParts, literal("metadata.json")]);

    let meta: Record<string, any> = {
      metricId: `local-metric-${metricName}`,
      name: metricName,
      description: null,
      tags: [],
      metadata: null,
      totalDataPoints: 0,
      nextIndex: 0,
      createdAt: utcNowIso(),
    };
    if (existsSync(metadataFile)) {
      try {
        meta = JSON.parse(readFileSync(metadataFile, "utf8"));
      } catch {
        /* reinitialise from the default above */
      }
    }

    const startIndex: number = meta.nextIndex ?? 0;
    const batchTs = utcNowIso();
    let out = "";
    dataPoints.forEach((data, i) => {
      out += JSON.stringify({ index: startIndex + i, data, createdAt: batchTs }) + "\n";
    });
    if (out) appendFileSync(dataFile, out);

    meta.nextIndex = startIndex + dataPoints.length;
    meta.totalDataPoints = (meta.totalDataPoints ?? 0) + dataPoints.length;
    meta.updatedAt = batchTs;
    writeFileSync(metadataFile, JSON.stringify(meta));
  }

  // ── files ──────────────────────────────────────────────────────────────────

  private filesDir(prefix: string, mode: "read" | "write" = "write"): string {
    return this.target([LocalStorage.prefixPart(prefix), literal("files")], mode);
  }

  /** The parts of a stored file's path, from the root down. */
  private fileParts(prefix: string, sub: string, ...rest: PathPart[]): PathPart[] {
    const parts: PathPart[] = [LocalStorage.prefixPart(prefix), literal("files")];
    // Python's storage lstrips a leading separator here; anything else in the
    // path is checked rather than repaired.
    const normalized = (sub ?? "").replace(/^\/+/, "");
    if (normalized) parts.push({ label: "file path", value: normalized, nested: true });
    return [...parts, ...rest];
  }

  loadFilesMetadata(prefix: string): { files: LocalFileRecord[] } {
    const file = this.target([LocalStorage.prefixPart(prefix), literal("files"), literal(FILES_METADATA_FILENAME)], "read");
    if (!existsSync(file)) return { files: [] };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(parsed?.files) ? parsed : { files: [] };
    } catch {
      return { files: [] };
    }
  }

  private saveFilesMetadata(prefix: string, data: { files: LocalFileRecord[] }): void {
    mkdirSync(this.filesDir(prefix), { recursive: true });
    const file = this.target([LocalStorage.prefixPart(prefix), literal("files"), literal(FILES_METADATA_FILENAME)]);
    // Write-then-rename: a crash mid-write would otherwise leave the manifest
    // unparseable and orphan every file it listed. The temporary name is a
    // target of its own, so a planted link cannot catch the write either.
    const tmp = this.target([
      LocalStorage.prefixPart(prefix),
      literal("files"),
      literal(`${FILES_METADATA_FILENAME}.tmp-${process.pid}`),
    ]);
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  }

  /** Non-deleted file records for an experiment. */
  listFiles(prefix: string, pathPrefix?: string, tags?: string[]): LocalFileRecord[] {
    let files = this.loadFilesMetadata(prefix).files.filter((f) => f.deletedAt === null);
    if (pathPrefix) files = files.filter((f) => (f.path ?? "").startsWith(pathPrefix));
    if (tags?.length) {
      const wanted = new Set(tags);
      files = files.filter((f) => (f.tags ?? []).some((t) => wanted.has(t)));
    }
    return files;
  }

  /** Absolute on-disk path of a recorded file. */
  filePath(prefix: string, record: Pick<LocalFileRecord, "id" | "path" | "filename">): string {
    return this.target(
      this.fileParts(
        prefix,
        record.path ?? "",
        { label: "file id", value: String(record.id) },
        { label: "filename", value: record.filename },
      ),
      "read",
    );
  }

  /** Copy a file in and record it, replacing any record with the same path+filename. */
  async writeFile(args: {
    prefix: string;
    project: string;
    sourcePath: string;
    path?: string;
    filename: string;
    description?: string | null;
    tags?: string[] | null;
    bindrs?: string[] | null;
    metadata?: Record<string, unknown> | null;
    checksum?: string;
    contentType?: string;
    sizeBytes?: number;
  }): Promise<LocalFileRecord> {
    const fileId = generateSnowflakeId();
    const idPart: PathPart = { label: "file id", value: fileId };
    const namePart: PathPart = { label: "filename", value: args.filename };
    const fileDir = this.target(this.fileParts(args.prefix, args.path ?? "", idPart));
    const destination = this.target(this.fileParts(args.prefix, args.path ?? "", idPart, namePart));
    const filename = args.filename;
    mkdirSync(fileDir, { recursive: true });
    await copyFile(args.sourcePath, destination);

    const now = utcNowIso();
    const record: LocalFileRecord = {
      id: fileId,
      experimentId: `${args.project}/${args.prefix}`,
      path: args.path ?? "",
      filename,
      description: args.description ?? null,
      tags: args.tags ?? [],
      bindrs: args.bindrs ?? [],
      contentType: args.contentType ?? "",
      sizeBytes: args.sizeBytes ?? statSync(destination).size,
      checksum: args.checksum ?? "",
      metadata: args.metadata ?? null,
      uploadedAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    const meta = this.loadFilesMetadata(args.prefix);
    const existingIndex = meta.files.findIndex(
      (f) => f.path === record.path && f.filename === record.filename && f.deletedAt === null,
    );
    if (existingIndex >= 0) {
      const old = meta.files[existingIndex];
      // Only the directory this manifest created for that record, and only
      // if every component of it is a real directory under the root: never a
      // link the record could point at something else through.
      rmSync(
        this.target(
          this.fileParts(args.prefix, old.path ?? "", { label: "file id", value: String(old.id) }),
        ),
        { recursive: true, force: true },
      );
      meta.files[existingIndex] = record;
    } else {
      meta.files.push(record);
    }
    this.saveFilesMetadata(args.prefix, meta);
    return record;
  }
}
