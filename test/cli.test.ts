import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, type TestContext } from "node:test";
import { makeJwt, startFakeServer, type FakeServer } from "./fake-server.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO, "bin", "ml-dash.js");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, for assertions that do not care which. */
  out: string;
}

interface Harness {
  server: FakeServer;
  /** Per-test ML_DASH_CONFIG_DIR, so no test can see another's credentials. */
  configDir: string;
  cli: (args: string[], opts?: { input?: string }) => Promise<RunResult>;
  login: () => Promise<RunResult>;
}

/**
 * Each test gets its own server and its own config directory.
 *
 * The node test runner may interleave suites, and both the fake server's
 * recorded-request log and the on-disk token are mutable state — sharing
 * either across tests makes assertions depend on execution order, which is
 * exactly the kind of test that passes for the wrong reason.
 */
async function harness(t: TestContext): Promise<Harness> {
  const server = await startFakeServer();
  const configDir = mkdtempSync(path.join(tmpdir(), "ml-dash-test-"));
  t.after(async () => {
    await server.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  const cli = (args: string[], opts: { input?: string } = {}): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [ENTRY, ...args], {
        env: {
          ...process.env,
          ML_DASH_CONFIG_DIR: configDir,
          ML_DASH_NO_KEYCHAIN: "1",
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", reject);
      child.stdin.end(opts.input ?? "");
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr, out: stdout + stderr }));
    });

  return {
    server,
    configDir,
    cli,
    /** A real device-flow login against the fake auth server. */
    login: () => cli(["login", "--dash-url", server.url, "--auth-url", server.url, "--no-browser"]),
  };
}

// ── version ──────────────────────────────────────────────────────────────────

describe("version", () => {
  test("prints the package version", async (t) => {
    const h = await harness(t);
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
    const r = await h.cli(["version"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), `ml-dash ${pkg.version}`);
  });

  test("unknown commands fail loudly rather than silently succeeding", async (t) => {
    const h = await harness(t);
    const r = await h.cli(["frobnicate"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown command 'frobnicate'/);
  });

  test("upload/download report that they are not in this build", async (t) => {
    const h = await harness(t);
    const r = await h.cli(["upload", "./somewhere"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not available in this build/);
  });
});

// ── login / logout ───────────────────────────────────────────────────────────

describe("login", () => {
  test("runs the device flow, exchanges the token, and stores it without printing it", async (t) => {
    const h = await harness(t);
    const r = await h.login();
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /WDJB-MJHT/);
    assert.match(r.stdout, /Logged in successfully/);

    // The credential must never reach the terminal.
    assert.ok(!r.out.includes(h.server.state.mlDashToken), "login printed the ml-dash token");

    // The device identity was sent as a hash of a locally generated secret,
    // and the same hash was used to poll.
    const start = h.server.requests.find((q) => q.path === "/api/device/start");
    const poll = h.server.requests.find((q) => q.path === "/api/device/poll");
    assert.ok(start && poll);
    assert.equal(start.body.client_id, "ml-dash-client");
    assert.match(start.body.device_secret_hash, /^[0-9a-f]{64}$/);
    assert.equal(poll.body.device_secret_hash, start.body.device_secret_hash);
    // The raw secret stays local.
    assert.ok(!JSON.stringify(h.server.requests).includes(JSON.parse(readFileSync(path.join(h.configDir, "config.json"), "utf8")).device_secret));

    // The exchange carried the vuer-auth bearer, and the token landed on disk.
    const exchange = h.server.requests.find((q) => q.path === "/api/auth/exchange");
    assert.ok(exchange?.headers.authorization?.toString().startsWith("Bearer "));
    assert.ok(existsSync(path.join(h.configDir, "tokens.encrypted")), "no token file written");

    // Encrypted at rest: the token must not be readable in the file.
    const onDisk = readFileSync(path.join(h.configDir, "tokens.encrypted"), "utf8");
    assert.ok(!onDisk.includes(h.server.state.mlDashToken));
  });

  test("a denied authorization exits non-zero", async (t) => {
    const h = await harness(t);
    h.server.state.pollError = "access_denied";
    const r = await h.login();
    assert.equal(r.code, 1);
    assert.match(r.out, /Authorization denied/);
    assert.ok(!existsSync(path.join(h.configDir, "tokens.encrypted")));
  });
});

describe("logout", () => {
  test("clears a stored token so later commands are unauthenticated", async (t) => {
    const h = await harness(t);
    assert.equal((await h.login()).code, 0);
    const out = await h.cli(["logout"]);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /Logged out successfully/);

    const after = await h.cli(["profile", "--json", "--dash-url", h.server.url]);
    assert.equal(JSON.parse(after.stdout).authenticated, false);
  });
});

// ── profile ──────────────────────────────────────────────────────────────────

describe("profile", () => {
  test("without a token reports unauthenticated and exits 0", async (t) => {
    const h = await harness(t);
    const r = await h.cli(["profile", "--json", "--dash-url", h.server.url]);
    assert.equal(r.code, 0);
    const info = JSON.parse(r.stdout);
    assert.equal(info.authenticated, false);
    assert.equal(info.remote_url, h.server.url);
  });

  test("fetches the live profile from the server by default", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["profile", "--json", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    const info = JSON.parse(r.stdout);
    assert.equal(info.authenticated, true);
    assert.equal(info.source, "server");
    // The server says "test-user"; the token's own claim says "token-user".
    assert.equal(info.user.username, "test-user");
    // A 19-digit user ID survives the round trip intact.
    assert.equal(info.user.sub, "9876543210987654321");
    assert.ok(h.server.graphqlQueries.some((q) => q.includes("GetCurrentUser")));
  });

  test("--cached reads the token's own claims and makes no request", async (t) => {
    const h = await harness(t);
    await h.login();
    h.server.graphqlQueries.length = 0;
    const r = await h.cli(["profile", "--json", "--cached", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    const info = JSON.parse(r.stdout);
    assert.equal(info.source, "token");
    assert.equal(info.user.username, "token-user");
    assert.equal(h.server.graphqlQueries.length, 0, "--cached still hit the server");
  });

  test("an expired token is reported as unauthenticated", async (t) => {
    const h = await harness(t);
    h.server.state.mlDashToken = makeJwt({ username: "stale" }, -60);
    await h.login();
    const r = await h.cli(["profile", "--json", "--dash-url", h.server.url]);
    const info = JSON.parse(r.stdout);
    assert.equal(info.authenticated, false);
    assert.match(info.error, /Token expired/);
  });

  test("renders a human panel when --json is absent", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["profile", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Authenticated/);
    assert.match(r.stdout, /test-user/);
  });
});

// ── api ──────────────────────────────────────────────────────────────────────

describe("api", () => {
  test("wraps a bare selection set and prints the JSON result", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["api", "--query", "me { username }", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(r.stdout), { me: { username: "test-user" } });
    const sent = h.server.graphqlQueries.at(-1)!;
    assert.equal(sent, "{ me { username } }");
  });

  test("--jq extracts a dot path", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["api", "-q", "me { username }", "--jq", ".me.username", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(r.stdout), "test-user");
  });

  test("a bad --jq path exits 1", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["api", "-q", "me { username }", "--jq", ".me.nope", "--dash-url", h.server.url]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Error extracting path/);
  });

  test("single quotes are rewritten for GraphQL and mutations are wrapped", async (t) => {
    const h = await harness(t);
    await h.login();
    await h.cli(["api", "-m", "updateUser(username: 'newname') { username }", "--dash-url", h.server.url]);
    const sent = h.server.graphqlQueries.at(-1)!;
    assert.equal(sent, 'mutation { updateUser(username: "newname") { username } }');
  });

  test("--query and --mutation together is a usage error", async (t) => {
    const h = await harness(t);
    const r = await h.cli(["api", "-q", "me { id }", "-m", "x { y }", "--dash-url", h.server.url]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not allowed with each other/);
  });

  test("neither --query nor --mutation is a usage error", async (t) => {
    const h = await harness(t);
    const r = await h.cli(["api", "--dash-url", h.server.url]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /is required/);
  });
});

// ── create ───────────────────────────────────────────────────────────────────

describe("create", () => {
  test("posts a PROJECT node and prints the 19-digit ID unrounded", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["create", "-p", "gamma", "-d", "a new project", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);

    const post = h.server.requests.find((q) => q.method === "POST" && q.path.endsWith("/nodes"));
    assert.ok(post, "no node POST reached the server");
    assert.equal(post.body.type, "PROJECT");
    assert.equal(post.body.name, "gamma");
    assert.equal(post.body.slug, "gamma");
    assert.equal(post.body.description, "a new project");
    assert.equal(post.path, "/api/namespaces/test-user/nodes");

    assert.match(r.stdout, /Project created successfully/);
    // The server sent id 4444444444444444444 as a bare JSON number.
    assert.match(r.stdout, /ID: 4444444444444444444/);
    assert.match(r.stdout, /https:\/\/dash\.ml\/@test-user\/gamma/);
  });

  test("an existing project is reported, not duplicated, and exits 0", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["create", "-p", "alpha", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /already exists/);
  });

  test("a namespace/project argument is split", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["create", "-p", "someone-else/delta", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    const post = h.server.requests.find((q) => q.method === "POST" && q.path.endsWith("/nodes"));
    assert.equal(post!.path, "/api/namespaces/someone-else/nodes");
    assert.equal(post!.body.name, "delta");
  });

  test("a three-part project argument is rejected without any request", async (t) => {
    const h = await harness(t);
    await h.login();
    h.server.requests.length = 0;
    const r = await h.cli(["create", "-p", "a/b/c", "--dash-url", h.server.url]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /at most 2 parts/);
    assert.equal(h.server.requests.length, 0, "a rejected argument still hit the server");
  });

  test("without -p it is a usage error", async (t) => {
    const h = await harness(t);
    const r = await h.cli(["create", "--dash-url", h.server.url]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /required/);
  });

  test("without a token it refuses before making a request", async (t) => {
    const h = await harness(t);
    h.server.requests.length = 0;
    const r = await h.cli(["create", "-p", "gamma", "--dash-url", h.server.url]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Not authenticated/);
    assert.equal(h.server.requests.length, 0);
  });
});

// ── remove ───────────────────────────────────────────────────────────────────

describe("remove", () => {
  test("-y deletes the project and reports the counts", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["remove", "-p", "alpha", "-y", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    const del = h.server.requests.find((q) => q.method === "DELETE");
    assert.ok(del, "no DELETE reached the server");
    assert.equal(del.path, "/api/projects/1111111111111111111");
    assert.match(r.stdout, /deleted from namespace/);
    assert.match(r.stdout, /Deleted nodes: 3/);
    assert.ok(!h.server.state.projects.some((p) => p.slug === "alpha"));
  });

  test("a missing project exits 0 and deletes nothing", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["remove", "-p", "not-a-project", "-y", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /not found/);
    assert.ok(!h.server.requests.some((q) => q.method === "DELETE"));
  });

  test("without -y and without a terminal it refuses to delete", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["remove", "-p", "alpha", "--dash-url", h.server.url]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Refusing to delete/);
    assert.ok(!h.server.requests.some((q) => q.method === "DELETE"), "deleted without confirmation");
    assert.ok(h.server.state.projects.some((p) => p.slug === "alpha"));
  });
});

// ── list ─────────────────────────────────────────────────────────────────────

describe("list", () => {
  test("with no -p lists projects", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["list", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Projects/);
    assert.match(r.stdout, /alpha/);
    assert.match(r.stdout, /first project/);
    assert.match(r.stdout, /2 projects total/);
  });

  test("with -p lists that project's experiments with their counts", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["list", "-p", "alpha", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Experiments in project: alpha/);
    assert.match(r.stdout, /exp-one/);
    assert.match(r.stdout, /COMPLETED/);
    assert.match(r.stdout, /nested\/exp-two/);
    assert.match(r.stdout, /RUNNING/);
  });

  test("every documented -p alias reaches the same code path", async (t) => {
    const h = await harness(t);
    await h.login();
    for (const flag of ["-p", "--project", "--proj", "--prefix", "--pref"]) {
      const r = await h.cli(["list", flag, "alpha", "--dash-url", h.server.url]);
      assert.equal(r.code, 0, `${flag}: ${r.out}`);
      assert.match(r.stdout, /Experiments in project: alpha/, `${flag} did not list experiments`);
    }
  });

  test("--tags filters client-side", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["list", "-p", "alpha", "--tags", "tuning", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /exp-two/);
    assert.ok(!r.stdout.includes("exp-one"), "tag filter kept a non-matching experiment");
  });

  test("--status is passed to the server and rejected when invalid", async (t) => {
    const h = await harness(t);
    await h.login();
    const ok = await h.cli(["list", "-p", "alpha", "--status", "RUNNING", "--dash-url", h.server.url]);
    assert.equal(ok.code, 0, ok.out);
    const sent = h.server.requests.find((q) => q.path === "/graphql" && q.body?.variables?.status);
    assert.equal(sent?.body.variables.status, "RUNNING");

    const bad = await h.cli(["list", "-p", "alpha", "--status", "SLEEPING", "--dash-url", h.server.url]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /invalid choice/);
  });

  test("a wildcard -p is expanded to a three-segment search pattern", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["list", "-p", "exp*", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Search results for: test-user\/exp\*\/\*/);
    const search = h.server.requests.find((q) => q.body?.query?.includes("SearchExperimentsPaginated"));
    assert.equal(search?.body.variables.pattern, "test-user/exp*/*");
  });

  test("a two-segment wildcard keeps the given namespace", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["list", "-p", "someone/proj*", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    const search = h.server.requests.find((q) => q.body?.query?.includes("SearchExperimentsPaginated"));
    assert.equal(search?.body.variables.pattern, "someone/proj*/*");
  });

  test("--detailed adds the tag and time columns", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["list", "-p", "alpha", "--detailed", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Tags/);
    assert.match(r.stdout, /baseline/);
  });

  test("--tracks lists an experiment's tracks", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["list", "--tracks", "-p", "test-user/alpha/exp-one", "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /robot\/joints/);
    assert.match(r.stdout, /120/);
    // Only the first five columns are shown, with an overflow marker.
    assert.match(r.stdout, /\+2\)/);
    assert.match(r.stdout, /0\.500 - 12\.250/);
    const tracks = h.server.requests.find((q) => q.path.endsWith("/tracks"));
    assert.equal(tracks?.path, "/api/experiments/1234567890123456789/tracks");
  });

  test("--tracks without a three-part path is rejected", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["list", "--tracks", "-p", "alpha", "--dash-url", h.server.url]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /namespace\/project\/experiment/);
  });

  test("without a token it refuses before making a request", async (t) => {
    const h = await harness(t);
    h.server.requests.length = 0;
    const r = await h.cli(["list", "--dash-url", h.server.url]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Not authenticated/);
    assert.equal(h.server.requests.length, 0);
  });
});

// ── config plumbing ──────────────────────────────────────────────────────────

describe("configuration", () => {
  test("remote_url from ~/.dash/config.json is used when --dash-url is absent", async (t) => {
    const h = await harness(t);
    await h.login();
    const cfgPath = path.join(h.configDir, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.remote_url = h.server.url;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    h.server.requests.length = 0;
    const r = await h.cli(["list"]);
    assert.equal(r.code, 0, r.out);
    assert.ok(h.server.requests.length > 0, "config remote_url was not used");
  });

  test("an api_key in the config authenticates without a login", async (t) => {
    const h = await harness(t);
    mkdirSync(h.configDir, { recursive: true });
    writeFileSync(
      path.join(h.configDir, "config.json"),
      JSON.stringify({ remote_url: h.server.url, api_key: h.server.state.mlDashToken }, null, 2),
    );
    const r = await h.cli(["list"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /alpha/);
  });

  test("--api-url is accepted as an alias of --dash-url", async (t) => {
    const h = await harness(t);
    await h.login();
    const r = await h.cli(["list", "--api-url", h.server.url]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /alpha/);
  });

  test("a corrupt config.json does not block the CLI", async (t) => {
    const h = await harness(t);
    mkdirSync(h.configDir, { recursive: true });
    writeFileSync(path.join(h.configDir, "config.json"), "{not json");
    const r = await h.cli(["version"]);
    assert.equal(r.code, 0);
  });
});
