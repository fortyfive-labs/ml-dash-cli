/**
 * A stand-in ml-dash + vuer-auth server for the CLI's behaviour tests.
 *
 * The tests drive the real compiled CLI as a subprocess, so the only thing
 * that may be faked is the far side of the socket. This server answers the
 * exact endpoints the CLI calls and records every request, which is what lets
 * a test assert on what the CLI *sent* (device_secret_hash, node type, the
 * expanded search pattern) rather than only on what it printed.
 *
 * IDs here are deliberately 19-digit Snowflakes emitted as bare JSON numbers,
 * the shape that `JSON.parse` silently rounds. A test that asserts the printed
 * ID digit-for-digit therefore fails if the CLI ever parses IDs naively.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  body: any;
  /** Query string, so a test can assert on bufferOnly / limit / offset. */
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}

/** One `multipart/form-data` part, with the file bytes kept intact. */
export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export interface FakeServer {
  url: string;
  requests: RecordedRequest[];
  /** Requests whose parsed body carries a GraphQL query string. */
  graphqlQueries: string[];
  close: () => Promise<void>;
  state: FakeState;
}

/** Everything the transfer commands read from or write to the server. */
export interface TransferState {
  /** What `upload` sent, keyed by experiment id. */
  receivedParameters: Record<string, any>;
  receivedLogs: Record<string, any[]>;
  receivedMetrics: Record<string, Record<string, any[]>>;
  receivedFiles: { filename: string; checksum: string; fields: Record<string, string>; data: Buffer }[];
  /** What `download` is offered. */
  parameters: Record<string, unknown>;
  logs: any[];
  metrics: Record<string, { chunks: any[][]; buffer: any[] }>;
  files: any[];
  /** File id → bytes served by /api/nodes/{id}/download. */
  fileBodies: Record<string, Buffer>;
  /** Substring of a path that should answer 500 instead of succeeding. */
  failPath?: string;
}

export interface FakeState {
  transfer: TransferState;
  username: string;
  userId: string;
  projects: { id: string; slug: string; description: string; experimentCount: number }[];
  experiments: any[];
  tracks: any[];
  /** Topic → entries the CLI appended, and what `/data` serves back. */
  trackEntries: Record<string, any[]>;
  /** Token handed back by /api/auth/exchange. */
  mlDashToken: string;
  /** When set, /api/device/poll answers with this error instead of a token. */
  pollError?: string;
}

const EXP_ID = "1234567890123456789";

export function defaultState(): FakeState {
  return {
    username: "test-user",
    userId: "9876543210987654321",
    projects: [
      { id: "1111111111111111111", slug: "alpha", description: "first project", experimentCount: 2 },
      { id: "2222222222222222222", slug: "beta", description: "", experimentCount: 0 },
    ],
    experiments: [
      {
        id: EXP_ID,
        name: "exp-one",
        displayPath: "exp-one",
        description: "",
        tags: ["baseline"],
        status: "COMPLETED",
        startedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
        metadata: null,
        project: { id: "1111111111111111111", slug: "alpha", namespace: { slug: "test-user" } },
        logMetadata: { totalLogs: 7 },
        metrics: [{ name: "loss" }, { name: "acc" }],
        files: [{ id: "3333333333333333333" }],
        trackCount: 1,
      },
      {
        id: "1234567890123456790",
        name: "exp-two",
        displayPath: "nested/exp-two",
        description: "",
        tags: ["tuning"],
        status: "RUNNING",
        startedAt: "2026-02-01T00:00:00Z",
        createdAt: "2026-02-01T00:00:00Z",
        metadata: null,
        project: { id: "1111111111111111111", slug: "alpha", namespace: { slug: "test-user" } },
        logMetadata: { totalLogs: 0 },
        metrics: [],
        files: [],
        trackCount: 0,
      },
    ],
    tracks: [
      {
        topic: "robot/joints",
        totalEntries: 120,
        columns: ["t", "q0", "q1", "q2", "q3", "q4", "q5"],
        firstTimestamp: 0.5,
        lastTimestamp: 12.25,
      },
    ],
    trackEntries: {},
    mlDashToken: makeJwt({ sub: "9876543210987654321", username: "token-user", name: "Token User" }),
    transfer: {
      receivedParameters: {},
      receivedLogs: {},
      receivedMetrics: {},
      receivedFiles: [],
      parameters: {},
      logs: [],
      metrics: {},
      files: [],
      fileBodies: {},
    },
  };
}

export const EXPERIMENT_ID = EXP_ID;

/** An unsigned JWT — the CLI only ever decodes the payload for display. */
export function makeJwt(payload: Record<string, unknown>, expOffsetSeconds = 30 * 86400): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + expOffsetSeconds };
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(body)}.signature`;
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

/**
 * Split a multipart/form-data body on its boundary.
 *
 * The file part is kept as raw bytes rather than decoded to a string: the
 * upload test hashes it and compares against the checksum the CLI sent, and a
 * utf8 round trip would quietly repair a corrupted binary body.
 */
export function parseMultipart(body: Buffer, contentType: string): MultipartPart[] {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!match) return [];
  const boundary = Buffer.from(`--${(match[1] ?? match[2]).trim()}`);

  const parts: MultipartPart[] = [];
  let index = body.indexOf(boundary);
  while (index !== -1) {
    const start = index + boundary.length;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    // Drop the CRLF after the boundary and the CRLF before the next one.
    const section = body.subarray(start + 2, next - 2);
    const split = section.indexOf("\r\n\r\n");
    if (split !== -1) {
      const headers = section.subarray(0, split).toString("utf8");
      const name = /name="([^"]*)"/.exec(headers)?.[1];
      if (name) {
        parts.push({
          name,
          filename: /filename="([^"]*)"/.exec(headers)?.[1],
          contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1],
          data: section.subarray(split + 4),
        });
      }
    }
    index = next;
  }
  return parts;
}

/** Raw JSON so 19-digit IDs stay literal — JSON.stringify of a number would not. */
const sendRaw = (res: ServerResponse, status: number, raw: string): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(raw);
};
const sendJson = (res: ServerResponse, status: number, body: unknown): void =>
  sendRaw(res, status, JSON.stringify(body));

export async function startFakeServer(state: FakeState = defaultState()): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const graphqlQueries: string[] = [];

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rawBuffer = await readBody(req);
    const contentType = String(req.headers["content-type"] ?? "");
    let body: any = undefined;
    let multipart: MultipartPart[] = [];
    if (rawBuffer.length > 0 && contentType.includes("json")) {
      try {
        body = JSON.parse(rawBuffer.toString("utf8"));
      } catch {
        body = rawBuffer.toString("utf8");
      }
    } else if (rawBuffer.length > 0 && contentType.includes("multipart/form-data")) {
      multipart = parseMultipart(rawBuffer, contentType);
      body = Object.fromEntries(
        multipart.map((p) => [p.name, p.filename !== undefined ? `<file:${p.filename}>` : p.data.toString("utf8")]),
      );
    } else if (rawBuffer.length > 0) {
      body = rawBuffer.toString("utf8");
    }
    const query = Object.fromEntries(url.searchParams.entries());
    requests.push({ method: req.method ?? "GET", path: url.pathname, body, query, headers: req.headers });

    // ── vuer-auth device flow ────────────────────────────────────────────────
    if (url.pathname === "/api/device/start") {
      return sendJson(res, 200, {
        user_code: "WDJB-MJHT",
        verification_uri: `${addr()}/device`,
        verification_uri_complete: `${addr()}/device?code=WDJBMJHT`,
        expires_in: 600,
        interval: 5,
      });
    }
    if (url.pathname === "/api/device/poll") {
      if (state.pollError) return sendJson(res, 400, { error: state.pollError });
      return sendJson(res, 200, { access_token: makeJwt({ sub: "auth-subject" }, 600) });
    }
    if (url.pathname === "/api/auth/exchange") {
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        return sendJson(res, 401, { error: "missing bearer" });
      }
      return sendJson(res, 200, { ml_dash_token: state.mlDashToken });
    }

    // Everything past this point needs the ml-dash token.
    if (req.headers.authorization !== `Bearer ${state.mlDashToken}`) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    // ── GraphQL ──────────────────────────────────────────────────────────────
    if (url.pathname === "/graphql") {
      const query: string = body?.query ?? "";
      const vars: Record<string, any> = body?.variables ?? {};
      graphqlQueries.push(query);
      return sendRaw(res, 200, graphqlResponse(state, query, vars));
    }

    // ── REST ─────────────────────────────────────────────────────────────────
    // An injected failure, so a test can prove the CLI reports a broken
    // section as a failure instead of finishing 0 with the data dropped.
    if (state.transfer.failPath && url.pathname.includes(state.transfer.failPath)) {
      return sendJson(res, 500, { error: "injected failure" });
    }

    const t = state.transfer;
    const expMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)\/(.+)$/);
    if (expMatch) {
      const experimentId = expMatch[1];
      const rest = expMatch[2];

      if (rest === "parameters" && req.method === "POST") {
        t.receivedParameters[experimentId] = body?.data ?? {};
        return sendJson(res, 200, { data: body?.data ?? {} });
      }
      if (rest === "parameters" && req.method === "GET") {
        return sendJson(res, 200, { data: t.parameters });
      }
      if (rest === "logs" && req.method === "POST") {
        (t.receivedLogs[experimentId] ??= []).push(...(body?.logs ?? []));
        return sendJson(res, 201, { created: (body?.logs ?? []).length });
      }
      if (rest === "logs" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const slice = t.logs.slice(offset, offset + limit);
        return sendJson(res, 200, { logs: slice, hasMore: offset + limit < t.logs.length });
      }
      if (rest === "metrics" && req.method === "GET") {
        return sendJson(res, 200, {
          metrics: Object.keys(t.metrics).map((name) => ({ name })),
        });
      }

      const metricMatch = rest.match(/^metrics\/([^/]+)\/(.+)$/);
      if (metricMatch) {
        const metricName = decodeURIComponent(metricMatch[1]);
        const action = metricMatch[2];

        if (action === "append-batch" && req.method === "POST") {
          const perExperiment = (t.receivedMetrics[experimentId] ??= {});
          (perExperiment[metricName] ??= []).push(...(body?.dataPoints ?? []));
          return sendJson(res, 200, { count: (body?.dataPoints ?? []).length });
        }
        const metric = t.metrics[metricName];
        if (!metric) return sendJson(res, 404, { error: `no metric ${metricName}` });

        if (action === "stats") {
          return sendJson(res, 200, {
            totalChunks: metric.chunks.length,
            bufferedDataPoints: metric.buffer.length,
          });
        }
        const chunkMatch = action.match(/^chunks\/(\d+)$/);
        if (chunkMatch) {
          const chunk = metric.chunks[Number(chunkMatch[1])];
          if (!chunk) return sendJson(res, 404, { error: "no such chunk" });
          return sendJson(res, 200, { data: chunk });
        }
        if (action === "data") {
          if (url.searchParams.get("bufferOnly") === "true") {
            return sendJson(res, 200, { data: metric.buffer, hasMore: false });
          }
          const startIndex = Number(url.searchParams.get("startIndex") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 1000);
          const all = [...metric.chunks.flat(), ...metric.buffer];
          const slice = all.slice(startIndex, startIndex + limit);
          return sendJson(res, 200, { data: slice, hasMore: startIndex + limit < all.length });
        }
      }
    }

    const downloadMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/download$/);
    if (downloadMatch && req.method === "GET") {
      const bytes = t.fileBodies[downloadMatch[1]];
      if (!bytes) return sendJson(res, 404, { error: "no such file" });
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(bytes);
    }

    const nodesMatch = url.pathname.match(/^\/api\/namespaces\/([^/]+)\/nodes$/);
    if (nodesMatch && req.method === "POST" && multipart.length > 0) {
      const filePart = multipart.find((p) => p.filename !== undefined);
      const fields = Object.fromEntries(
        multipart.filter((p) => p.filename === undefined).map((p) => [p.name, p.data.toString("utf8")]),
      );
      t.receivedFiles.push({
        filename: filePart?.filename ?? "",
        checksum: fields.checksum ?? "",
        fields,
        data: filePart?.data ?? Buffer.alloc(0),
      });
      const id = `700000000000000${String(t.receivedFiles.length).padStart(4, "0")}`;
      return sendRaw(
        res,
        201,
        `{"node":{"id":${id},"experimentId":"${fields.experimentId ?? ""}","createdAt":"2026-01-01T00:00:00Z"},` +
          `"physicalFile":{"contentType":"${fields.name?.endsWith(".json") ? "application/json" : "application/octet-stream"}",` +
          `"sizeBytes":${filePart?.data.length ?? 0},"checksum":"${fields.checksum ?? ""}"}}`,
      );
    }
    if (nodesMatch && req.method === "POST") {
      if (body?.type === "EXPERIMENT") {
        return sendRaw(
          res,
          201,
          `{"experiment":{"id":${EXP_ID}},"node":{"id":6666666666666666666}}`,
        );
      }
      if (body?.type === "PROJECT") {
        const slug = body.slug ?? body.name;
        if (state.projects.some((p) => p.slug === slug)) {
          return sendJson(res, 409, { error: "project already exists" });
        }
        const id = "4444444444444444444";
        state.projects.push({ id, slug, description: body.description ?? "", experimentCount: 0 });
        // `id` is a bare number here on purpose: a naive JSON.parse rounds it.
        return sendRaw(res, 201, `{"project":{"id":${id},"slug":"${slug}"}}`);
      }
      return sendJson(res, 201, { node: { id: "5555555555555555555" } });
    }

    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && req.method === "DELETE") {
      const id = projectMatch[1];
      const before = state.projects.length;
      state.projects = state.projects.filter((p) => p.id !== id);
      if (state.projects.length === before) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, { deleted: 3, experiments: 1 });
    }

    // The topic is one percent-encoded path segment, exactly as the server
    // routes it: `/tracks/:topic/append_batch` with `decodeURIComponent` on
    // the far side. Only the underscore spelling exists here, so the hyphen
    // the client used to send falls through to the 404 below.
    const trackBatchMatch = url.pathname.match(
      /^\/api\/experiments\/([^/]+)\/tracks\/([^/]+)\/append_batch$/,
    );
    if (trackBatchMatch && req.method === "POST") {
      const topic = decodeURIComponent(trackBatchMatch[2]);
      const entries = body?.entries;
      if (!Array.isArray(entries) || entries.length === 0) {
        return sendJson(res, 400, { error: "Bad Request", message: "entries must be a non-empty array" });
      }
      for (const [i, entry] of entries.entries()) {
        if (entry?.timestamp === undefined || entry?.timestamp === null) {
          return sendJson(res, 400, { error: "Bad Request", message: `Entry at index ${i} is missing timestamp` });
        }
      }
      (state.trackEntries[topic] ??= []).push(...entries);
      return sendJson(res, 201, { count: entries.length, topic });
    }

    const trackDataMatch = url.pathname.match(
      /^\/api\/experiments\/([^/]+)\/tracks\/([^/]+)\/data$/,
    );
    if (trackDataMatch && req.method === "GET") {
      const topic = decodeURIComponent(trackDataMatch[2]);
      const entries = state.trackEntries[topic] ?? [];
      const format = url.searchParams.get("format") ?? "json";
      if (format === "jsonl") {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        return res.end(entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
      }
      return sendJson(res, 200, { topic, count: entries.length, entries });
    }

    const tracksMatch = url.pathname.match(/^\/api\/experiments\/([^/]+)\/tracks$/);
    if (tracksMatch && req.method === "GET") {
      const topic = url.searchParams.get("topic");
      const tracks = topic ? state.tracks.filter((t) => t.topic.startsWith(topic.replace(/\*$/, ""))) : state.tracks;
      return sendJson(res, 200, { tracks });
    }

    return sendJson(res, 404, { error: `no fake route for ${req.method} ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const addr = () => `http://127.0.0.1:${port}`;

  return {
    url: addr(),
    requests,
    graphqlQueries,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function graphqlResponse(state: FakeState, query: string, vars: Record<string, any>): string {
  const page = <T>(items: T[], limit: number, offset: number) => ({
    slice: items.slice(offset, offset + limit),
    totalCount: items.length,
    hasMore: offset + limit < items.length,
  });

  if (query.includes("GetCurrentUser")) {
    return `{"data":{"me":{"id":${state.userId},"username":"${state.username}","email":"test@example.com","name":"Test User","given_name":"Test","family_name":"User","picture":null}}}`;
  }
  if (query.includes("ProjectsPaginated")) {
    const { slice, totalCount, hasMore } = page(state.projects, vars.limit ?? 50, vars.offset ?? 0);
    const projects = slice.map(
      (p) =>
        `{"id":${p.id},"name":"${p.slug}","slug":"${p.slug}","description":"${p.description}","tags":[],"experimentCount":${p.experimentCount}}`,
    );
    return `{"data":{"projectsPaginated":{"projects":[${projects.join(",")}],"totalCount":${totalCount},"hasMore":${hasMore}}}}`;
  }
  if (query.includes("SearchExperimentsPaginated")) {
    const { slice, totalCount, hasMore } = page(state.experiments, vars.limit ?? 50, vars.offset ?? 0);
    return `{"data":{"searchExperimentsPaginated":{"experiments":${JSON.stringify(slice)},"totalCount":${totalCount},"hasMore":${hasMore}}}}`;
  }
  if (query.includes("ExperimentsPaginated")) {
    const { slice, totalCount, hasMore } = page(state.experiments, vars.limit ?? 50, vars.offset ?? 0);
    return `{"data":{"experimentsPaginated":{"experiments":${JSON.stringify(slice)},"totalCount":${totalCount},"hasMore":${hasMore}}}}`;
  }
  if (query.includes("query Experiment(")) {
    const exp = state.experiments.find((e) => e.name === vars.experimentName);
    if (!exp) return `{"data":{"experiment":null}}`;
    return `{"data":{"experiment":{"id":${exp.id},"name":"${exp.name}","description":"","tags":[],"status":"${exp.status}","metadata":${JSON.stringify(exp.metadata ?? null)},"project":{"slug":"alpha","namespace":{"slug":"${state.username}"}},"logMetadata":{"totalLogs":0},"metrics":[],"files":[],"parameters":null}}}`;
  }
  if (query.includes("ListExperimentFilesPaginated")) {
    const { slice, totalCount, hasMore } = page(state.transfer.files, vars.limit ?? 500, vars.offset ?? 0);
    return `{"data":{"experimentById":{"filesPaginated":{"files":${JSON.stringify(slice)},"totalCount":${totalCount},"hasMore":${hasMore}}}}}`;
  }
  if (query.includes("GetExperimentNode")) {
    return `{"data":{"experimentNode":{"id":6666666666666666666}}}`;
  }
  if (query.includes("GetExperimentProject")) {
    return `{"data":{"experimentById":{"projectId":${state.projects[0].id}}}}`;
  }
  if (query.includes("GetProject(")) {
    const projects = state.projects.map((p) => `{"id":${p.id},"slug":"${p.slug}"}`);
    return `{"data":{"namespace":{"projects":[${projects.join(",")}]}}}`;
  }
  if (query.includes("me {") || query.includes("GetMyNamespace")) {
    return `{"data":{"me":{"username":"${state.username}"}}}`;
  }
  return `{"errors":[{"message":"fake server has no handler for this query"}]}`;
}
