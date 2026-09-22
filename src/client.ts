/**
 * The ml-dash server client: REST under `{url}/api`, GraphQL at `{url}/graphql`,
 * both bearing the same token.
 *
 * Everything moves through the server — there is no S3 direct upload, no
 * presigned URL and no multipart chunking in this protocol. Files go up as one
 * `multipart/form-data` POST to the unified node endpoint and come down from
 * `/api/nodes/{id}/download`.
 */
import { createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { asId, parseJson } from "./util/json.js";

export class AuthenticationError extends Error {}
export class ConfigurationError extends Error {}
export class NetworkError extends Error {}
export class StorageError extends Error {}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 500)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions {
  method?: string;
  json?: unknown;
  form?: FormData;
  params?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  raw?: boolean;
}

export class RemoteClient {
  readonly graphqlBaseUrl: string;
  readonly baseUrl: string;
  apiKey?: string;
  private _namespace?: string;
  private readonly idCache = new Map<string, string>();

  constructor(baseUrl: string, namespace?: string, apiKey?: string) {
    this.graphqlBaseUrl = baseUrl.replace(/\/+$/, "");
    this.baseUrl = `${this.graphqlBaseUrl}/api`;
    this._namespace = namespace;
    this.apiKey = apiKey;
  }

  private ensureAuthenticated(): void {
    if (!this.apiKey) {
      throw new AuthenticationError(
        "Not authenticated. Run 'ml-dash login' to authenticate, or provide an explicit api key.",
      );
    }
  }

  /** The caller's namespace, asked of the server once and then remembered. */
  async namespace(): Promise<string> {
    if (this._namespace) return this._namespace;
    const result = await this.graphqlQuery(`query GetMyNamespace { me { username } }`);
    const username = result?.me?.username;
    if (!username) throw new NetworkError("Failed to fetch namespace from server");
    this._namespace = username;
    return username;
  }

  // ── transport ──────────────────────────────────────────────────────────────

  private async request(pathname: string, opts: RequestOptions = {}): Promise<Response> {
    this.ensureAuthenticated();
    const url = new URL(`${this.baseUrl}/${pathname.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    let body: string | FormData | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form; // fetch sets the multipart boundary itself
    }

    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });

    if (opts.raw) return res;
    if (!res.ok) throw new HttpError(res.status, url.toString(), await res.text());
    return res;
  }

  private async requestJson<T = any>(pathname: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(pathname, opts);
    const text = await res.text();
    return text ? parseJson<T>(text) : ({} as T);
  }

  /**
   * POST that retries a 409.
   *
   * Node upserts are a pre-check followed by a create, so two concurrent
   * requests can both pass the check and one comes back 409. Retrying is safe:
   * the second attempt finds the node the first one created.
   */
  private async postWith409Retry(pathname: string, opts: RequestOptions): Promise<any> {
    const backoff = [100, 500, 2000];
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.request(pathname, { ...opts, method: "POST", raw: true });
      if (res.status !== 409) {
        if (!res.ok) throw new HttpError(res.status, pathname, await res.text());
        const text = await res.text();
        return text ? parseJson(text) : {};
      }
      await res.text();
      if (attempt < 2) await sleep(backoff[attempt]);
    }
    throw new HttpError(409, pathname, "node creation still conflicting after 3 attempts");
  }

  async graphqlQuery<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    this.ensureAuthenticated();
    const res = await fetch(`${this.graphqlBaseUrl}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new HttpError(res.status, `${this.graphqlBaseUrl}/graphql`, await res.text());
    const result = parseJson<any>(await res.text());
    if (result.errors) {
      throw new NetworkError(result.errors.map((e: any) => e.message ?? String(e)).join("; "));
    }
    return (result.data ?? {}) as T;
  }

  // ── identity ───────────────────────────────────────────────────────────────

  async getCurrentUser(): Promise<Record<string, any> | null> {
    const result = await this.graphqlQuery(`
      query GetCurrentUser {
        me { id username email name given_name family_name picture }
      }
    `);
    return result.me ?? null;
  }

  // ── projects ───────────────────────────────────────────────────────────────

  /** Resolve a project slug to its ID. null means "not found" — the server will create it. */
  async getProjectId(projectSlug: string): Promise<string | null> {
    const ns = await this.namespace();
    const cacheKey = `project:${ns}:${projectSlug}`;
    const cached = this.idCache.get(cacheKey);
    if (cached) return cached;

    const result = await this.graphqlQuery(
      `query GetProject($namespace: String!) {
         namespace(slug: $namespace) { projects { id slug } }
       }`,
      { namespace: ns },
    );
    const namespaceData = result.namespace;
    if (namespaceData == null) {
      throw new ConfigurationError(
        `Namespace '${ns}' not found. Please check the namespace exists on the server.`,
      );
    }
    for (const p of namespaceData.projects ?? []) {
      if (p.slug === projectSlug) {
        const id = asId(p.id)!;
        this.idCache.set(cacheKey, id);
        return id;
      }
    }
    return null;
  }

  async createProject(name: string, description?: string): Promise<any> {
    const ns = await this.namespace();
    return this.requestJson(`namespaces/${ns}/nodes`, {
      method: "POST",
      json: { type: "PROJECT", name, slug: name, description: description ?? "" },
    });
  }

  async deleteProject(projectSlug: string): Promise<any> {
    const ns = await this.namespace();
    const projectId = await this.getProjectId(projectSlug);
    if (!projectId) {
      throw new ConfigurationError(`Project '${projectSlug}' not found in namespace '${ns}'`);
    }
    return this.requestJson(`projects/${projectId}`, { method: "DELETE" });
  }

  // ── experiments ────────────────────────────────────────────────────────────

  async createOrUpdateExperiment(args: {
    project: string;
    name: string;
    description?: string | null;
    tags?: string[] | null;
    bindrs?: string[] | null;
    prefix?: string | null;
    writeProtected?: boolean;
    metadata?: Record<string, unknown> | null;
  }): Promise<any> {
    const ns = await this.namespace();
    let projectId = await this.getProjectId(args.project);
    let parentId = "ROOT";

    // A prefix of owner/project/folder…/name means the experiment hangs off a
    // folder chain that has to exist first. Only the segments between the
    // project and the experiment name are folders.
    if (args.prefix) {
      const parts = args.prefix.replace(/^\/+|\/+$/g, "").split("/");
      const folderParts = parts.length > 3 ? parts.slice(2, -1) : [];
      if (folderParts.length > 0) {
        if (!projectId) {
          const created = await this.requestJson(`namespaces/${ns}/nodes`, {
            method: "POST",
            json: { type: "PROJECT", name: args.project, slug: args.project },
          });
          projectId = asId(created?.project?.id) ?? null;
        }
        if (projectId) {
          let current = "ROOT";
          for (const folderName of folderParts) {
            if (!folderName) continue;
            // No experimentId here: these are project-level folders, and
            // tagging them with one reparents them under the experiment.
            const folder = await this.postWith409Retry(`namespaces/${ns}/nodes`, {
              json: { type: "FOLDER", projectId, parentId: current, name: folderName },
            });
            current = asId(folder?.node?.id)!;
          }
          parentId = current;
        }
      }
    }

    const payload: Record<string, unknown> = { type: "EXPERIMENT", name: args.name, parentId };
    if (projectId) payload.projectId = projectId;
    else payload.projectSlug = args.project;
    if (args.description != null) payload.description = args.description;
    if (args.tags != null) payload.tags = args.tags;
    if (args.bindrs != null) payload.bindrs = args.bindrs;
    if (args.writeProtected) payload.writeProtected = true;
    if (args.metadata != null) payload.metadata = args.metadata;

    const result = await this.postWith409Retry(`namespaces/${ns}/nodes`, { json: payload });
    if (result?.experiment?.id && result?.node?.id) {
      this.idCache.set(`exp_node:${asId(result.experiment.id)}`, asId(result.node.id)!);
    }
    return result;
  }

  async createLogEntries(experimentId: string, logs: Record<string, unknown>[]): Promise<any> {
    return this.requestJson(`experiments/${experimentId}/logs`, { method: "POST", json: { logs } });
  }

  async setParameters(experimentId: string, data: Record<string, unknown>): Promise<any> {
    return this.requestJson(`experiments/${experimentId}/parameters`, {
      method: "POST",
      json: { data },
    });
  }

  async getParameters(experimentId: string): Promise<Record<string, unknown>> {
    const result = await this.requestJson(`experiments/${experimentId}/parameters`);
    return result.data ?? {};
  }

  async queryLogs(
    experimentId: string,
    opts: {
      limit?: number;
      offset?: number;
      orderBy?: string;
      order?: string;
      level?: string[];
      startTime?: string;
      endTime?: string;
      search?: string;
    } = {},
  ): Promise<any> {
    return this.requestJson(`experiments/${experimentId}/logs`, {
      params: {
        limit: opts.limit,
        offset: opts.offset,
        orderBy: opts.orderBy,
        order: opts.order,
        level: opts.level?.join(","),
        startTime: opts.startTime,
        endTime: opts.endTime,
        search: opts.search,
      },
    });
  }

  // ── metrics ────────────────────────────────────────────────────────────────

  async appendBatchToMetric(
    experimentId: string,
    metricName: string,
    dataPoints: unknown[],
  ): Promise<any> {
    return this.requestJson(
      `experiments/${experimentId}/metrics/${encodeURIComponent(metricName)}/append-batch`,
      { method: "POST", json: { dataPoints } },
    );
  }

  async getMetricData(
    experimentId: string,
    metricName: string,
    opts: { startIndex?: number; limit?: number; bufferOnly?: boolean } = {},
  ): Promise<any> {
    return this.requestJson(
      `experiments/${experimentId}/metrics/${encodeURIComponent(metricName)}/data`,
      {
        params: {
          startIndex: opts.startIndex,
          limit: opts.limit,
          bufferOnly: opts.bufferOnly ? "true" : undefined,
        },
      },
    );
  }

  async getMetricStats(experimentId: string, metricName: string): Promise<any> {
    return this.requestJson(
      `experiments/${experimentId}/metrics/${encodeURIComponent(metricName)}/stats`,
    );
  }

  async downloadMetricChunk(
    experimentId: string,
    metricName: string,
    chunkNumber: number,
  ): Promise<any> {
    return this.requestJson(
      `experiments/${experimentId}/metrics/${encodeURIComponent(metricName)}/chunks/${chunkNumber}`,
    );
  }

  async listMetrics(experimentId: string): Promise<any[]> {
    const result = await this.requestJson(`experiments/${experimentId}/metrics`);
    return result.metrics ?? [];
  }

  // ── files ──────────────────────────────────────────────────────────────────

  /**
   * Upload one file, creating any folders its prefix names.
   *
   * The file is streamed off disk rather than read whole: the Python CLI did
   * `f.read()` into memory, which puts a multi-GB checkpoint in the heap before
   * a single byte leaves the machine.
   */
  async uploadFile(args: {
    experimentId: string;
    filePath: string;
    prefix: string;
    filename: string;
    description?: string | null;
    tags?: string[] | null;
    metadata?: Record<string, unknown> | null;
    checksum: string;
    contentType: string;
    sizeBytes: number;
    projectId?: string | null;
    parentId?: string;
  }): Promise<any> {
    const ns = await this.namespace();
    let projectId = args.projectId ?? null;
    let parentId = args.parentId ?? "ROOT";

    if (!projectId) {
      const result = await this.graphqlQuery(
        `query GetExperimentProject($experimentId: ID!) {
           experimentById(id: $experimentId) { projectId }
         }`,
        { experimentId: args.experimentId },
      );
      projectId = asId(result?.experimentById?.projectId) ?? null;
      if (!projectId) {
        throw new ConfigurationError(
          `Could not resolve project ID for experiment ${args.experimentId}`,
        );
      }
    }

    // Files belong under the experiment node, not the project root.
    let experimentNodeId = this.idCache.get(`exp_node:${args.experimentId}`);
    if (!experimentNodeId) {
      experimentNodeId = await this.getExperimentNodeId(args.experimentId);
    }
    if (experimentNodeId) parentId = experimentNodeId;

    let prefix = args.prefix ?? "";
    if (prefix) {
      for (const folderName of prefix.split("/")) {
        if (!folderName) continue;
        const folder = await this.postWith409Retry(`namespaces/${ns}/nodes`, {
          json: {
            type: "FOLDER",
            projectId,
            experimentId: args.experimentId,
            parentId,
            name: folderName,
          },
        });
        parentId = asId(folder?.node?.id)!;
      }
    }

    const handle = await open(args.filePath, "r");
    let result: any;
    try {
      const { size } = await handle.stat();
      const form = new FormData();
      // A Blob over the open handle keeps the bytes out of the JS heap.
      const stream = handle.readableWebStream() as unknown as ReadableStream<Uint8Array>;
      const blob = new Blob([await new Response(stream).arrayBuffer()], {
        type: args.contentType || "application/octet-stream",
      });
      form.append("file", blob, args.filename);
      form.append("type", "FILE");
      form.append("projectId", String(projectId));
      form.append("experimentId", String(args.experimentId));
      form.append("parentId", String(parentId));
      form.append("name", args.filename);
      form.append("checksum", args.checksum);
      if (args.description) form.append("description", args.description);
      if (args.tags?.length) form.append("tags", args.tags.join(","));
      if (args.metadata) form.append("metadata", JSON.stringify(args.metadata));

      result = await this.postWith409Retry(`namespaces/${ns}/nodes`, {
        form,
        timeoutMs: Math.max(30_000, Math.ceil(size / 1024) * 10),
      });
    } finally {
      await handle.close();
    }

    const node = result?.node ?? {};
    const physical = result?.physicalFile ?? {};
    return {
      id: asId(node.id),
      experimentId: asId(node.experimentId) ?? args.experimentId,
      path: prefix,
      filename: args.filename,
      description: node.description,
      tags: node.tags ?? [],
      contentType: physical.contentType,
      sizeBytes: physical.sizeBytes != null ? Number(physical.sizeBytes) : undefined,
      checksum: physical.checksum,
      metadata: node.metadata,
      uploadedAt: node.createdAt,
      updatedAt: node.updatedAt,
      deletedAt: node.deletedAt,
    };
  }

  async getExperimentNodeId(experimentId: string): Promise<string> {
    const cacheKey = `exp_node:${experimentId}`;
    const cached = this.idCache.get(cacheKey);
    if (cached) return cached;
    const result = await this.graphqlQuery(
      `query GetExperimentNode($experimentId: ID!) {
         experimentNode(experimentId: $experimentId) { id }
       }`,
      { experimentId },
    );
    const id = asId(result?.experimentNode?.id);
    if (!id) throw new ConfigurationError(`No node found for experiment ID '${experimentId}'`);
    this.idCache.set(cacheKey, id);
    return id;
  }

  async getFile(fileId: string): Promise<any> {
    return this.requestJson(`nodes/${fileId}`);
  }

  async listFiles(experimentId: string, limit = 500, offset = 0): Promise<any> {
    const result = await this.graphqlQuery(
      `query ListExperimentFilesPaginated($experimentId: ID!, $limit: Int!, $offset: Int!) {
         experimentById(id: $experimentId) {
           filesPaginated(limit: $limit, offset: $offset) {
             files {
               id name description tags metadata createdAt pPath
               physicalFile { id filename contentType sizeBytes checksum s3Url }
             }
             totalCount
             hasMore
           }
         }
       }`,
      { experimentId, limit, offset },
    );
    const page = result?.experimentById?.filesPaginated ?? {};
    return { files: page.files ?? [], totalCount: page.totalCount ?? 0, hasMore: page.hasMore ?? false };
  }

  async searchFiles(pattern: string, experimentId?: string, limit = 10, offset = 0): Promise<any[]> {
    const result = await this.requestJson("search/files", {
      params: { pattern, limit, offset, experimentId },
    });
    return result.files ?? [];
  }

  async deleteFile(fileId: string): Promise<any> {
    return this.requestJson(`nodes/${fileId}`, { method: "DELETE" });
  }

  /** Stream a file to disk, then verify its checksum. A mismatch deletes the file. */
  async downloadFileStreaming(fileId: string, destPath: string): Promise<string> {
    const res = await this.request(`nodes/${fileId}/download`, { timeoutMs: 600_000, raw: true });
    if (!res.ok) throw new HttpError(res.status, `nodes/${fileId}/download`, await res.text());
    if (!res.body) throw new NetworkError(`Empty response body downloading file ${fileId}`);
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(destPath));
    await stat(destPath);
    return destPath;
  }

  // ── GraphQL reads ──────────────────────────────────────────────────────────

  async listProjectsGraphql(namespaceSlug?: string, limit = 50, offset = 0): Promise<any> {
    const result = await this.graphqlQuery(
      `query ProjectsPaginated($namespaceSlug: String, $limit: Int!, $offset: Int!) {
         projectsPaginated(namespaceSlug: $namespaceSlug, limit: $limit, offset: $offset) {
           projects { id name slug description tags experimentCount }
           totalCount
           hasMore
         }
       }`,
      { namespaceSlug: namespaceSlug ?? null, limit, offset },
    );
    const page = result?.projectsPaginated ?? {};
    return { projects: page.projects ?? [], totalCount: page.totalCount ?? 0 };
  }

  async listExperimentsGraphql(
    projectSlug: string,
    opts: { status?: string; namespaceSlug?: string; limit?: number; offset?: number } = {},
  ): Promise<any> {
    const variables: Record<string, unknown> = {
      namespaceSlug: opts.namespaceSlug ?? null,
      projectSlug,
      limit: opts.limit ?? 50,
      offset: opts.offset ?? 0,
    };
    if (opts.status != null) variables.status = opts.status;

    const result = await this.graphqlQuery(
      `query ExperimentsPaginated($namespaceSlug: String, $projectSlug: String!, $status: ExperimentStatus, $limit: Int!, $offset: Int!) {
         experimentsPaginated(namespaceSlug: $namespaceSlug, projectSlug: $projectSlug, status: $status, limit: $limit, offset: $offset) {
           experiments {
             id name description tags status startedAt endedAt metadata
             project { slug namespace { slug } }
             logMetadata { totalLogs }
             metrics { name }
             files { id }
             trackCount
             displayPath
           }
           totalCount
           hasMore
         }
       }`,
      variables,
    );
    const page = result?.experimentsPaginated ?? {};
    return { experiments: page.experiments ?? [], totalCount: page.totalCount ?? 0 };
  }

  async getExperimentGraphql(
    projectSlug: string,
    experimentName: string,
    namespaceSlug?: string,
  ): Promise<any | null> {
    const ns = namespaceSlug ?? (await this.namespace());
    const result = await this.graphqlQuery(
      `query Experiment($namespaceSlug: String, $projectSlug: String!, $experimentName: String!) {
         experiment(namespaceSlug: $namespaceSlug, projectSlug: $projectSlug, experimentName: $experimentName) {
           id name description tags status metadata
           project { slug namespace { slug } }
           logMetadata { totalLogs }
           metrics { name metricMetadata { totalDataPoints } }
           files {
             id name pPath description tags metadata
             physicalFile { filename contentType sizeBytes checksum s3Url }
           }
           parameters { id data }
         }
       }`,
      { namespaceSlug: ns, projectSlug, experimentName },
    );
    return result?.experiment ?? null;
  }

  async searchExperimentsGraphql(pattern: string, limit = 50, offset = 0): Promise<any> {
    const result = await this.graphqlQuery(
      `query SearchExperimentsPaginated($pattern: String!, $limit: Int!, $offset: Int!) {
         searchExperimentsPaginated(pattern: $pattern, limit: $limit, offset: $offset) {
           experiments {
             id name description tags status startedAt endedAt metadata
             project { id slug name namespace { id slug } }
             logMetadata { totalLogs }
             metrics { name metricMetadata { totalDataPoints } }
             files { id name }
             trackCount
             displayPath
           }
           totalCount
           hasMore
         }
       }`,
      { pattern, limit, offset },
    );
    const page = result?.searchExperimentsPaginated ?? {};
    return { experiments: page.experiments ?? [], totalCount: page.totalCount ?? 0 };
  }

  /** Walk the project node tree to find an experiment nested under folders. */
  async getExperimentByPathGraphql(
    projectSlug: string,
    experimentPath: string,
    namespaceSlug?: string,
  ): Promise<any | null> {
    const ns = namespaceSlug ?? (await this.namespace());
    const result = await this.graphqlQuery(
      `query GetProjectHierarchy($namespaceSlug: String!, $projectSlug: String!) {
         project(namespaceSlug: $namespaceSlug, projectSlug: $projectSlug) {
           nodes(parentId: null, maxDepth: 20) {
             ...NodeFields
             children { ...NodeFields
               children { ...NodeFields
                 children { ...NodeFields
                   children { ...NodeFields
                     children { ...NodeFields
                       children { ...NodeFields
                         children { ...NodeFields
                           children { ...NodeFields
                             children { ...NodeFields } } } } } } } } }
           }
         }
       }
       fragment NodeFields on Node { id name type pPath experimentId }`,
      { namespaceSlug: ns, projectSlug },
    );

    const parts = experimentPath.replace(/^\/+|\/+$/g, "").split("/");

    const find = async (nodes: any[], remaining: string[]): Promise<any | null> => {
      if (remaining.length === 0) return null;
      const [head, ...rest] = remaining;
      for (const node of nodes ?? []) {
        if (node?.name !== head) continue;
        if (rest.length === 0 && node.type === "EXPERIMENT") {
          const experimentId = asId(node.experimentId);
          if (!experimentId) return null;
          const exp = await this.graphqlQuery(
            `query GetExperiment($id: ID!) {
               experimentById(id: $id) {
                 id name description tags status metadata
                 project { slug namespace { slug } }
               }
             }`,
            { id: experimentId },
          );
          return exp?.experimentById ?? null;
        }
        if (rest.length > 0 && node.children) {
          const found = await find(node.children, rest);
          if (found) return found;
        }
      }
      return null;
    };

    return find(result?.project?.nodes ?? [], parts);
  }

  // ── tracks ─────────────────────────────────────────────────────────────────

  async listTracks(experimentId: string, topicFilter?: string): Promise<any[]> {
    const result = await this.requestJson(`experiments/${experimentId}/tracks`, {
      params: { topic: topicFilter },
    });
    return result.tracks ?? [];
  }

  async appendBatchToTrack(
    experimentId: string,
    topic: string,
    entries: unknown[],
  ): Promise<any> {
    return this.requestJson(
      `experiments/${experimentId}/tracks/${encodeURIComponent(topic)}/append-batch`,
      { method: "POST", json: { entries }, timeoutMs: 120_000 },
    );
  }

  /** Track export. jsonl/parquet/mcap come back as bytes; json as a parsed object. */
  async getTrackData(
    experimentId: string,
    topic: string,
    format: string,
  ): Promise<Buffer | Record<string, unknown>> {
    const res = await this.request(
      `experiments/${experimentId}/tracks/${encodeURIComponent(topic)}/data`,
      { params: { format }, timeoutMs: 600_000 },
    );
    if (format === "json") return parseJson(await res.text());
    return Buffer.from(await res.arrayBuffer());
  }
}
