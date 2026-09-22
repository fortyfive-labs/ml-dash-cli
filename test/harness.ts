/**
 * The shared subprocess harness: a real compiled CLI, a real HTTP server, and
 * a per-test config directory.
 *
 * It lives in its own module because `cli.test.ts` and `transfer.test.ts` both
 * drive the binary the same way, and a second copy would be a second thing to
 * keep honest.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { startFakeServer, defaultState, type FakeServer, type FakeState } from "./fake-server.js";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENTRY = path.join(REPO, "bin", "ml-dash.js");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, for assertions that do not care which. */
  out: string;
}

export interface Harness {
  server: FakeServer;
  /** Per-test ML_DASH_CONFIG_DIR, so no test can see another's credentials. */
  configDir: string;
  cli: (args: string[], opts?: { input?: string; cwd?: string }) => Promise<RunResult>;
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
export async function harness(t: TestContext, state: FakeState = defaultState()): Promise<Harness> {
  const server = await startFakeServer(state);
  const configDir = mkdtempSync(path.join(tmpdir(), "ml-dash-test-"));
  t.after(async () => {
    await server.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  const cli = (args: string[], opts: { input?: string; cwd?: string } = {}): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [ENTRY, ...args], {
        cwd: opts.cwd,
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

