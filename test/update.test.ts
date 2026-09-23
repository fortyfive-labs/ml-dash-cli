/**
 * `ml-dash update`, driven across the boundaries it actually crosses.
 *
 * The claim under test is that the command detects a new version and installs
 * it safely, so the important cases are run against real things: a real
 * compiled binary replacing itself on disk, a real HTTP server answering the
 * pointer/manifest/binary requests, and a real `node_modules` tree for the npm
 * channel. What cannot be exercised on this platform — the Windows post-exit
 * swap — is asserted as a contract on the script that gets written, and said
 * to be unexecuted rather than counted as verified.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { REPO } from "./harness.js";
import { startReleaseFixture, type ReleaseFixture } from "./release-fixture.js";

import { PACKAGE_NAME, detectChannel } from "../src/update/channel.js";
import { PLATFORM_KEYS, UnsupportedPlatformError, detectPlatform } from "../src/update/platform.js";
import {
  DEFAULT_PUBLIC_URL,
  UpdateSourceError,
  isStrictSemver,
  readBounded,
  readManifest,
  requireSafeOrigin,
  resolveBaseUrl,
} from "../src/update/release.js";
import { DEFAULT_REGISTRY, installArgs, findNpm, resolveRegistry } from "../src/update/npm.js";
import {
  checkReplaceable,
  receiptContents,
  windowsHelperArgs,
  windowsHelperScript,
} from "../src/update/replace.js";

const PKG = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const HOST_PLATFORM = detectPlatform();
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

/** Run a program and collect everything it said. */
function exec(
  command: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, NO_COLOR: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      // A CLI that never exits should fail a test, not wedge the whole run.
      timeout: 60_000,
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

// ── what the CLI advertises ──────────────────────────────────────────────────

describe("update: the command surface", () => {
  test("is listed in the root help and documents its flags", async () => {
    const root = await exec(process.execPath, [path.join(REPO, "bin", "ml-dash.js")]);
    assert.equal(root.code, 0, root.out);
    assert.match(root.out, /update\s+Update ml-dash to the latest version/);

    const help = await exec(process.execPath, [path.join(REPO, "bin", "ml-dash.js"), "update", "--help"]);
    assert.equal(help.code, 0, help.out);
    assert.match(help.out, /--check\s+Report whether an update exists; change nothing/);
    assert.match(help.out, /--version VERSION/);
    assert.match(help.out, /--json/);
  });

  test("refuses to run from a source checkout rather than touching a global install", async () => {
    const r = await exec(process.execPath, [path.join(REPO, "bin", "ml-dash.js"), "update"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /not an installed ml-dash/);
    assert.match(r.out, /source checkout/);
    assert.equal(detectChannel().kind, "source");
  });

  test("rejects a --version that is not a version, before any network call", async () => {
    const r = await exec(process.execPath, [path.join(REPO, "bin", "ml-dash.js"), "update", "--version", "latest"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /'latest' is not a version/);
  });

  test("the package name the npm channel installs is the one this package publishes", () => {
    assert.equal(PACKAGE_NAME, PKG.name);
  });
});

// ── origin rules ─────────────────────────────────────────────────────────────

describe("update: where an update may come from", () => {
  test("defaults to the published bucket and the public registry", () => {
    assert.deepEqual(resolveBaseUrl({}), { url: DEFAULT_PUBLIC_URL, overridden: false });
    assert.deepEqual(resolveRegistry({}), { url: DEFAULT_REGISTRY, overridden: false });
    assert.match(DEFAULT_PUBLIC_URL, /^https:\/\//);
  });

  test("an override must be https, or loopback http", () => {
    assert.equal(resolveBaseUrl({ ML_DASH_UPDATE_BASE_URL: "https://example.test/x/" }).url, "https://example.test/x");
    assert.equal(resolveBaseUrl({ ML_DASH_UPDATE_BASE_URL: "http://127.0.0.1:8080" }).overridden, true);
    assert.equal(resolveRegistry({ ML_DASH_UPDATE_REGISTRY: "http://localhost:1234" }).overridden, true);

    for (const bad of ["http://example.test", "http://10.0.0.1", "ftp://example.test", "not a url"]) {
      assert.throws(
        () => resolveBaseUrl({ ML_DASH_UPDATE_BASE_URL: bad }),
        UpdateSourceError,
        `accepted ${bad}`,
      );
    }
  });

  test("requireSafeOrigin is what rejects a redirect off the origin", () => {
    assert.throws(() => requireSafeOrigin("http://evil.test/x", "the server"), UpdateSourceError);
  });

  test("an oversized metadata body is stopped while streaming, not after buffering", async (t) => {
    // The cap has to hold against a source that lies about Content-Length and
    // then never stops sending, which is the case `await res.text()` cannot
    // defend against.
    const { createServer } = await import("node:http");
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sending = true;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const pump = () => {
        if (!sending) return void res.end();
        if (res.write(chunk)) setImmediate(pump);
        else res.once("drain", pump);
      };
      pump();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    t.after(async () => {
      sending = false;
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });

    const res = await fetch(`http://127.0.0.1:${port}/endless`);
    await assert.rejects(
      () => readBounded(res, 1024, "the pointer"),
      (e: Error) => e instanceof UpdateSourceError && /larger than 1024 bytes/.test(e.message),
    );
  });
});

// ── platform mapping ─────────────────────────────────────────────────────────

describe("update: platform selection", () => {
  test("produces exactly the keys the release manifest is indexed by", () => {
    const cases: [NodeJS.Platform, string, boolean, string][] = [
      ["darwin", "arm64", false, "darwin-arm64"],
      ["darwin", "x64", false, "darwin-x64"],
      ["linux", "x64", false, "linux-x64"],
      ["linux", "arm64", false, "linux-arm64"],
      ["linux", "x64", true, "linux-x64-musl"],
      ["linux", "arm64", true, "linux-arm64-musl"],
      ["win32", "x64", false, "windows-x64"],
      ["win32", "arm64", false, "windows-arm64"],
    ];
    for (const [platform, arch, musl, expected] of cases) {
      assert.equal(detectPlatform(platform, arch, () => musl), expected);
    }
    // Every key the build script emits is produced by some case above.
    assert.deepEqual(new Set(cases.map((c) => c[3])), new Set(PLATFORM_KEYS));
  });

  test("musl is never assumed on a non-linux host", () => {
    assert.equal(detectPlatform("darwin", "arm64", () => true), "darwin-arm64");
  });

  test("an unsupported host is refused rather than guessed at", () => {
    assert.throws(() => detectPlatform("freebsd", "x64", () => false), UnsupportedPlatformError);
    assert.throws(() => detectPlatform("linux", "riscv64", () => false), UnsupportedPlatformError);
  });
});

// ── manifest validation, against a real server ───────────────────────────────

describe("update: what a manifest is allowed to say", () => {
  let fixture: ReleaseFixture;
  before(async () => {
    fixture = await startReleaseFixture();
  });
  // A listening server keeps the event loop alive: without this the whole file
  // runs green and then hangs forever instead of reporting.
  after(() => fixture.close());

  test("a version that is not strict semver never reaches the network", async () => {
    for (const bad of ["1.2", "v1.2.3", "01.2.3", "../../etc", "latest"]) {
      assert.equal(isStrictSemver(bad), false, `${bad} passed`);
      await assert.rejects(() => readManifest(fixture.url, bad), UpdateSourceError);
    }
  });

  test("a manifest that disagrees with the version it was asked for is refused", async () => {
    fixture.builds.set("0.2.0", new Map([[HOST_PLATFORM, Buffer.from("x")]]));
    await assert.rejects(
      () => readManifest(fixture.url, "0.3.0"),
      (e: Error) => e instanceof UpdateSourceError && /HTTP 404/.test(e.message),
    );
  });

  test("a path-escaping or nonsense binary name is refused", async () => {
    // Served by a hand-written manifest so the entry can be malformed in ways
    // the real build script would never produce.
    for (const binary of ["../../evil", "sub/dir/ml-dash", "/etc/passwd", ""]) {
      const doc = JSON.stringify({
        version: "0.9.0",
        platforms: { [HOST_PLATFORM]: { binary, checksum: "a".repeat(64), size: 10 } },
      });
      await assert.rejects(
        () => readManifestFrom(doc, "0.9.0"),
        (e: Error) => e instanceof UpdateSourceError && /unusable file name/.test(e.message),
        `accepted ${binary}`,
      );
    }
  });

  test("a missing or malformed checksum or size is refused", async () => {
    const bad = [
      { binary: "ml-dash", checksum: "nope", size: 10 },
      { binary: "ml-dash", checksum: "A".repeat(64), size: 10 },
      { binary: "ml-dash", checksum: "a".repeat(64), size: 0 },
      { binary: "ml-dash", checksum: "a".repeat(64), size: -1 },
      { binary: "ml-dash", checksum: "a".repeat(64), size: 1e12 },
    ];
    for (const entry of bad) {
      const doc = JSON.stringify({ version: "0.9.0", platforms: { [HOST_PLATFORM]: entry } });
      await assert.rejects(() => readManifestFrom(doc, "0.9.0"), UpdateSourceError, JSON.stringify(entry));
    }
  });

  /** Serve `doc` from the fixture host and parse it through the real reader. */
  async function readManifestFrom(doc: string, version: string) {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(doc);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      return await readManifest(`http://127.0.0.1:${port}`, version);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});

// ── the replacement itself ───────────────────────────────────────────────────

describe("update: what may be replaced", () => {
  test("a symlink is refused — it belongs to whatever put it there", async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "ml-dash-replace-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "real"), "binary");
    symlinkSync(path.join(dir, "real"), path.join(dir, "ml-dash"));
    await assert.rejects(
      () => checkReplaceable(path.join(dir, "ml-dash")),
      (e: Error) => /is a symlink/.test(e.message),
    );
  });

  test("a read-only install directory is refused with something to do about it", async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "ml-dash-replace-"));
    t.after(() => {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    });
    writeFileSync(path.join(dir, "ml-dash"), "binary");
    chmodSync(dir, 0o555);
    await assert.rejects(
      () => checkReplaceable(path.join(dir, "ml-dash")),
      (e: Error) => /cannot write to/.test(e.message) && /install-dir/.test(e.message),
    );
  });

  test("a binary another package manager owns is refused, with that tool's command", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ml-dash-store-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    // process.execPath is symlink-resolved by the OS, so a symlinked install
    // hands this function the store's real path rather than the link. That is
    // the case this check exists for, and these are real files on disk.
    const cases: [string, RegExp][] = [
      ["opt/homebrew/Cellar/ml-dash/0.1.0/bin", /Homebrew/],
      ["nix/store/abc123-ml-dash/bin", /Nix/],
      ["usr/lib/python3.12/site-packages/bin", /pip/],
      ["home/u/.local/pipx/venvs/ml-dash/bin", /pipx/],
      ["usr/lib/node_modules/@dreamlake/ml-dash/bin", /npm/],
    ];
    for (const [relative, manager] of cases) {
      const dir = path.join(root, relative);
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, "ml-dash");
      writeFileSync(target, "binary");
      await assert.rejects(
        () => checkReplaceable(target),
        (e: Error) => manager.test(e.message) && /not this command's to replace/.test(e.message),
        relative,
      );
    }
  });

  test("an ordinary writable file is accepted", async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "ml-dash-replace-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "ml-dash"), "binary");
    await checkReplaceable(path.join(dir, "ml-dash"));
  });
});

// ── Windows: contract only, and said so ──────────────────────────────────────

describe("update: the Windows post-exit swap", () => {
  // This platform cannot run powershell.exe, so what is checked here is the
  // script that would be handed to it — not that it works. docs/RELEASE.md
  // records the Windows path as unexecuted for the same reason the
  // windows-arm64 build is.
  const swap = {
    target: "C:\\Users\\a b\\ml-dash.exe",
    staged: "C:\\Users\\a b\\.ml-dash.update.42.tmp",
    version: "0.1.2",
    platform: "windows-x64",
    sha256: "b".repeat(64),
    source: "https://example.test/ml-dash.exe",
  };

  test("waits for this exact process, then moves the verified file into place", () => {
    const script = windowsHelperScript(swap, 4242);
    assert.match(script, /Wait-Process -Id 4242 -Timeout 300/);
    assert.match(script, /Move-Item -LiteralPath '.*\.ml-dash\.update\.42\.tmp' -Destination '.*ml-dash\.exe' -Force/);
  });

  test("cleans up the download on failure and deletes itself either way", () => {
    const script = windowsHelperScript(swap, 1);
    assert.match(script, /catch \{\s*\n\s*Remove-Item -LiteralPath '[^']*\.tmp' -Force/);
    assert.match(script, /finally \{\s*\n\s*Remove-Item -LiteralPath \$PSCommandPath -Force/);
  });

  test("refreshes the install receipt in install.ps1's own format", () => {
    const script = windowsHelperScript(swap, 1);
    assert.match(script, /'channel=r2', 'version=0\.1\.2', 'platform=windows-x64'/);
    assert.match(script, /Set-Content -LiteralPath '[^']*\.ml-dash\.receipt' -Encoding ASCII/);
    // The same five keys install.sh writes, in the same order.
    assert.equal(
      receiptContents("0.1.2", "windows-x64", "b".repeat(64), "u").split("\n").slice(0, 5).map((l) => l.split("=")[0]).join(","),
      "channel,version,platform,sha256,source",
    );
  });

  test("a quote in a path cannot end the PowerShell string it sits in", () => {
    const target = "C:\\it's\\ml-dash.exe";
    const script = windowsHelperScript({ ...swap, target }, 1);
    const move = script.split("\n").find((l) => l.includes("Move-Item"))!;

    // The property that matters is not the escaping's spelling but that the
    // literals PowerShell would parse are exactly the paths we passed in: a
    // path holding a quote must not be able to terminate its own string and
    // let the rest of it be read as code.
    const literals = [...move.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    assert.deepEqual(literals, [swap.staged, target]);
    assert.match(move, /'C:\\it''s\\ml-dash\.exe'/);
  });

  test("is launched without a shell and without a profile", () => {
    const args = windowsHelperArgs("C:\\tmp\\helper.ps1");
    assert.deepEqual(args, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\tmp\\helper.ps1"]);
  });
});

// ── npm channel, through a real installed tree ───────────────────────────────

describe("update: the npm channel", () => {
  test("installs an exact version, as an argument array, never a command string", () => {
    assert.deepEqual(installArgs("0.1.2"), ["install", "--global", `${PACKAGE_NAME}@0.1.2`]);
    // No shell metacharacter can be introduced, because the version is a
    // single argv entry and is strict-semver checked before it gets here.
    assert.equal(installArgs("0.1.2")[2].includes(" "), false);
  });

  test("npm is found as something spawnable without a shell, and it runs", () => {
    const npm = findNpm();
    const r = spawnSync(npm.command, [...npm.prefix, "--version"], { encoding: "utf8", shell: false });
    assert.equal(r.status, 0, `${npm.command} ${npm.prefix.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  test("a real node_modules install reports the npm channel and checks the registry", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ml-dash-npm-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fixture = await startReleaseFixture();
    t.after(() => fixture.close());

    // A genuine global-style layout: the package under node_modules, with the
    // dependencies it resolves at runtime beside it.
    const pkgDir = path.join(root, "node_modules", PACKAGE_NAME);
    mkdirSync(pkgDir, { recursive: true });
    for (const entry of ["bin", "dist", "package.json"]) {
      cpSync(path.join(REPO, entry), path.join(pkgDir, entry), { recursive: true });
    }
    for (const dep of ["semver", "qrcode"]) {
      symlinkSync(path.join(REPO, "node_modules", dep), path.join(root, "node_modules", dep));
    }
    const entryPoint = path.join(pkgDir, "bin", "ml-dash.js");

    // The channel is npm, not "source", even though the package.json is the
    // same file the checkout has.
    fixture.npmLatest = "9.9.9";
    fixture.npmVersions.push(PKG.version, "9.9.9");
    const available = await exec(process.execPath, [entryPoint, "update", "--check", "--json"], {
      ML_DASH_UPDATE_REGISTRY: fixture.url,
    });
    assert.equal(available.code, 0, available.out);
    const report = JSON.parse(available.out.slice(available.out.indexOf("{")));
    assert.deepEqual(report, {
      channel: "npm",
      current: PKG.version,
      target: "9.9.9",
      update_available: true,
      action: "available",
    });

    // --check must not have run npm; only the registry was read.
    assert.ok(fixture.requests.every((r) => r.startsWith(`/${PACKAGE_NAME}`)), fixture.requests.join(", "));

    // Nothing newer: reported as such, exit 0.
    fixture.npmLatest = PKG.version;
    const current = await exec(process.execPath, [entryPoint, "update", "--check"], {
      ML_DASH_UPDATE_REGISTRY: fixture.url,
    });
    assert.equal(current.code, 0, current.out);
    assert.match(current.out, new RegExp(`ml-dash ${PKG.version.replace(/\./g, "\\.")} is the latest version on npm`));

    // A published version older than this one is refused, not installed.
    fixture.npmLatest = "0.0.1";
    fixture.npmVersions.push("0.0.1");
    const down = await exec(process.execPath, [entryPoint, "update"], {
      ML_DASH_UPDATE_REGISTRY: fixture.url,
    });
    assert.equal(down.code, 1);
    assert.match(down.out, /older than the installed/);
    assert.match(down.out, /does not downgrade/);
  });
});

// ── standalone channel, with a real compiled binary replacing itself ─────────

describe("update: a standalone binary updating itself", { skip: bunAvailable ? false : "bun is not installed" }, () => {
  const WORK = path.join(REPO, ".update-fixture");
  const OLD = "0.1.0";
  const NEW = PKG.version;
  let oldBinary: Buffer;
  let newBinary: Buffer;

  before(() => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    // Compiled inside the repo so bun resolves node_modules the same way a
    // release build does. Both binaries are this working tree's code; only the
    // version constant differs, so the update logic under test is the one that
    // runs in the "installed" copy.
    newBinary = compile(WORK, "new", NEW);
    oldBinary = compile(WORK, "old", OLD);
    assert.notDeepEqual(oldBinary, newBinary);
  });

  // Two compiled binaries and two source copies is ~130 MB; it does not stay
  // in the working tree after the run.
  after(() => rmSync(WORK, { recursive: true, force: true }));

  function compile(work: string, name: string, version: string): Buffer {
    const src = path.join(work, `src-${name}`);
    cpSync(path.join(REPO, "src"), src, { recursive: true });
    const versionFile = path.join(src, "version.ts");
    writeFileSync(versionFile, readFileSync(versionFile, "utf8").replace(/"[^"]+";$/m, `"${version}";`));
    const out = path.join(work, name);
    const r = spawnSync("bun", ["build", "--compile", `--outfile=${out}`, path.join(src, "index.ts")], {
      cwd: REPO,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `bun build failed: ${r.stderr}`);
    const check = spawnSync(out, ["version"], { encoding: "utf8" });
    assert.equal(check.stdout.trim(), `ml-dash ${version}`, "compiled binary misreports its version");
    return readFileSync(out);
  }

  /** A fresh install directory holding the old binary and its install receipt. */
  function install(t: { after: (fn: () => void) => void }): { dir: string; target: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "ml-dash-install-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const target = path.join(dir, "ml-dash");
    writeFileSync(target, oldBinary);
    chmodSync(target, 0o700);
    writeFileSync(
      path.join(dir, ".ml-dash.receipt"),
      receiptContents(OLD, HOST_PLATFORM, sha256(oldBinary), "https://example.test/old"),
    );
    return { dir, target };
  }

  async function serving(t: { after: (fn: () => void) => void }): Promise<ReleaseFixture> {
    const fixture = await startReleaseFixture();
    t.after(() => fixture.close());
    fixture.builds.set(NEW, new Map([[HOST_PLATFORM, newBinary]]));
    fixture.latest = NEW;
    return fixture;
  }

  test("--check reports the new version and changes nothing", async (t) => {
    const { dir, target } = install(t);
    const fixture = await serving(t);

    const r = await exec(target, ["update", "--check", "--json"], { ML_DASH_UPDATE_BASE_URL: fixture.url });
    assert.equal(r.code, 0, r.out);
    const report = JSON.parse(r.out.slice(r.out.indexOf("{")));
    assert.deepEqual(report, {
      channel: "standalone",
      current: OLD,
      target: NEW,
      update_available: true,
      action: "available",
    });

    assert.deepEqual(readFileSync(target), oldBinary, "--check replaced the binary");
    assert.deepEqual(readdirSync(dir).sort(), [".ml-dash.receipt", "ml-dash"]);
    // Only the pointer was read: no manifest, no binary.
    assert.deepEqual(fixture.requests, ["/ml-dash-cli/releases/latest"]);
  });

  test("--check on the newest version says so", async (t) => {
    const { target } = install(t);
    const fixture = await serving(t);
    fixture.builds.set(OLD, new Map([[HOST_PLATFORM, oldBinary]]));
    fixture.latest = OLD;

    const r = await exec(target, ["update", "--check"], { ML_DASH_UPDATE_BASE_URL: fixture.url });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`ml-dash ${OLD.replace(/\./g, "\\.")} is the latest ${HOST_PLATFORM} release`));
  });

  test("replaces itself, keeps its mode, refreshes the receipt and leaves no litter", async (t) => {
    const { dir, target } = install(t);
    const fixture = await serving(t);

    const r = await exec(target, ["update"], { ML_DASH_UPDATE_BASE_URL: fixture.url });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /sha256 ok/);
    assert.match(r.out, new RegExp(`Updated to ml-dash ${NEW.replace(/\./g, "\\.")}`));

    // The claim, checked by running the thing that was installed.
    const after = spawnSync(target, ["version"], { encoding: "utf8" });
    assert.equal(after.stdout.trim(), `ml-dash ${NEW}`);
    assert.deepEqual(readFileSync(target), newBinary);

    assert.equal(statSync(target).mode & 0o777, 0o700, "the install's permissions were not preserved");
    assert.deepEqual(readdirSync(dir).sort(), [".ml-dash.receipt", "ml-dash"], "a temporary file was left behind");

    const receipt = readFileSync(path.join(dir, ".ml-dash.receipt"), "utf8");
    assert.match(receipt, new RegExp(`^version=${NEW.replace(/\./g, "\\.")}$`, "m"));
    assert.match(receipt, new RegExp(`^sha256=${sha256(newBinary)}$`, "m"));
    assert.match(receipt, new RegExp(`^platform=${HOST_PLATFORM}$`, "m"));

    // Running it again is a no-op, because the pointer now matches.
    const again = await exec(target, ["update"], { ML_DASH_UPDATE_BASE_URL: fixture.url });
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /is the latest/);
  });

  test("a checksum mismatch keeps the old binary and removes the download", async (t) => {
    const { dir, target } = install(t);
    const fixture = await serving(t);
    // Same length, different bytes: the size check passes and the sha256 is
    // the thing that has to catch it.
    fixture.corrupt = randomBytes(newBinary.length);

    const r = await exec(target, ["update"], { ML_DASH_UPDATE_BASE_URL: fixture.url });
    assert.equal(r.code, 1);
    assert.match(r.out, /checksum mismatch/);
    assert.match(r.out, new RegExp(`${OLD.replace(/\./g, "\\.")} is still in place`));

    assert.deepEqual(readFileSync(target), oldBinary, "a bad download replaced the binary");
    assert.equal(spawnSync(target, ["version"], { encoding: "utf8" }).stdout.trim(), `ml-dash ${OLD}`);
    assert.deepEqual(readdirSync(dir).sort(), [".ml-dash.receipt", "ml-dash"], "the download was left behind");
  });

  test("a body longer than the manifest declares is cut off, not written out", async (t) => {
    const { dir, target } = install(t);
    const fixture = await serving(t);
    fixture.extraBytes = 4096;

    const r = await exec(target, ["update"], { ML_DASH_UPDATE_BASE_URL: fixture.url });
    assert.equal(r.code, 1);
    assert.match(r.out, /longer than the \d+ bytes the manifest declares/);
    assert.deepEqual(readFileSync(target), oldBinary);
    assert.deepEqual(readdirSync(dir).sort(), [".ml-dash.receipt", "ml-dash"]);
  });

  test("a release with no build for this platform is refused before anything is downloaded", async (t) => {
    const { dir, target } = install(t);
    const fixture = await serving(t);
    const other = HOST_PLATFORM === "linux-x64" ? "darwin-x64" : "linux-x64";
    fixture.builds.set(NEW, new Map([[other, newBinary]]));

    const r = await exec(target, ["update"], { ML_DASH_UPDATE_BASE_URL: fixture.url });
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`has no build for ${HOST_PLATFORM}`));
    assert.deepEqual(readdirSync(dir).sort(), [".ml-dash.receipt", "ml-dash"]);
  });

  test("a pointer that moves backwards does not downgrade the install", async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "ml-dash-install-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const target = path.join(dir, "ml-dash");
    writeFileSync(target, newBinary);
    chmodSync(target, 0o755);

    const fixture = await serving(t);
    fixture.builds.set(OLD, new Map([[HOST_PLATFORM, oldBinary]]));
    fixture.latest = OLD;

    const r = await exec(target, ["update"], { ML_DASH_UPDATE_BASE_URL: fixture.url });
    assert.equal(r.code, 1);
    assert.match(r.out, /does not downgrade/);
    assert.deepEqual(readFileSync(target), newBinary);
  });

  test("--version installs that exact build rather than the pointer's", async (t) => {
    const { target } = install(t);
    const fixture = await serving(t);
    // The pointer still says the old version; the explicit request wins.
    fixture.latest = OLD;
    fixture.builds.set(OLD, new Map([[HOST_PLATFORM, oldBinary]]));

    const r = await exec(target, ["update", "--version", NEW], { ML_DASH_UPDATE_BASE_URL: fixture.url });
    assert.equal(r.code, 0, r.out);
    assert.equal(spawnSync(target, ["version"], { encoding: "utf8" }).stdout.trim(), `ml-dash ${NEW}`);
  });

  test("an unreachable update source fails without touching the install", async (t) => {
    const { dir, target } = install(t);
    const fixture = await startReleaseFixture();
    const url = fixture.url;
    await fixture.close();

    const r = await exec(target, ["update"], { ML_DASH_UPDATE_BASE_URL: url });
    assert.equal(r.code, 1);
    assert.match(r.out, /cannot reach/);
    assert.deepEqual(readFileSync(target), oldBinary);
    assert.deepEqual(readdirSync(dir).sort(), [".ml-dash.receipt", "ml-dash"]);
  });

  test("a non-loopback http source is refused by the binary itself", async (t) => {
    const { target } = install(t);
    const r = await exec(target, ["update", "--check"], { ML_DASH_UPDATE_BASE_URL: "http://example.test" });
    assert.equal(r.code, 1);
    assert.match(r.out, /must be an https:\/\/ URL/);
  });
});
