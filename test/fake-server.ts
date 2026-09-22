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
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeServer {
  url: string;
  requests: RecordedRequest[];
  /** Requests whose parsed body carries a GraphQL query string. */
  graphqlQueries: string[];
  close: () => Promise<void>;
  state: FakeState;
}

export interface FakeState {
  username: string;
  userId: string;
  projects: { id: string; slug: string; description: string; experimentCount: number }[];
  experiments: any[];
  tracks: any[];
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
    mlDashToken: makeJwt({ sub: "9876543210987654321", username: "token-user", name: "Token User" }),
  };
}

/** An unsigned JWT — the CLI only ever decodes the payload for display. */
export function makeJwt(payload: Record<string, unknown>, expOffsetSeconds = 30 * 86400): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + expOffsetSeconds };
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(body)}.signature`;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

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
    const raw = await readBody(req);
    let body: any = undefined;
    if (raw && (req.headers["content-type"] ?? "").includes("json")) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    } else if (raw) {
      body = raw;
    }
    requests.push({ method: req.method ?? "GET", path: url.pathname, body, headers: req.headers });

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
    const nodesMatch = url.pathname.match(/^\/api\/namespaces\/([^/]+)\/nodes$/);
    if (nodesMatch && req.method === "POST") {
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
    return `{"data":{"experiment":{"id":${exp.id},"name":"${exp.name}","description":"","tags":[],"status":"${exp.status}","metadata":null,"project":{"slug":"alpha","namespace":{"slug":"${state.username}"}},"logMetadata":{"totalLogs":0},"metrics":[],"files":[],"parameters":null}}}`;
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
