/**
 * The npm channel: ask the registry, then let npm do the install.
 *
 * Nothing here unpacks a tarball or writes into node_modules. `npm install -g`
 * is the only supported way to change an npm install — it owns the global
 * prefix, the bin shims and the lockfile-free global tree — so this module's
 * whole job is to find the right npm, hand it an exact version, and check
 * afterwards that the version it left behind is the one that was asked for.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { PACKAGE_NAME } from "./channel.js";
import { UpdateSourceError, isStrictSemver, readBounded, requireSafeOrigin } from "./release.js";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

const REGISTRY_TIMEOUT_MS = 20_000;
/** The abbreviated packument is a few KB; the full one can be megabytes. */
const PACKUMENT_MAX_BYTES = 4 * 1024 * 1024;

/** Same narrow rule as the standalone channel's base URL — see release.ts. */
export function resolveRegistry(env: NodeJS.ProcessEnv = process.env): { url: string; overridden: boolean } {
  const raw = env.ML_DASH_UPDATE_REGISTRY?.trim();
  if (!raw) return { url: DEFAULT_REGISTRY, overridden: false };
  return { url: requireSafeOrigin(raw, "ML_DASH_UPDATE_REGISTRY").replace(/\/+$/, ""), overridden: true };
}

/**
 * `dist-tags.latest` for the package, read over plain HTTP rather than through
 * `npm view`: `npm view` exits non-zero for "no such package" and for "the
 * registry is unreachable" alike, and scripts/publish-release.sh already
 * refuses to conflate those two for exactly this reason.
 */
export async function latestPublishedVersion(registry: string): Promise<string> {
  const url = `${registry}/${encodeURIComponent(PACKAGE_NAME)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (e) {
    throw new UpdateSourceError(
      `cannot reach the npm registry at ${url}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  requireSafeOrigin(res.url || url, "the registry that answered");
  if (res.status === 404) {
    throw new UpdateSourceError(`${PACKAGE_NAME} is not published on ${registry}`);
  }
  if (!res.ok) throw new UpdateSourceError(`${url} returned HTTP ${res.status}`);

  const text = await readBounded(res, PACKUMENT_MAX_BYTES, `the registry document at ${url}`);
  let doc: { "dist-tags"?: Record<string, unknown> };
  try {
    doc = JSON.parse(text);
  } catch {
    throw new UpdateSourceError(`the registry document at ${url} is not JSON`);
  }
  const latest = doc["dist-tags"]?.latest;
  if (typeof latest !== "string" || !isStrictSemver(latest)) {
    throw new UpdateSourceError(`${registry} reports no usable 'latest' version for ${PACKAGE_NAME}`);
  }
  return latest;
}

/** Whether the registry actually has this exact version, before npm is run. */
export async function versionExists(registry: string, version: string): Promise<boolean> {
  const url = `${registry}/${encodeURIComponent(PACKAGE_NAME)}/${encodeURIComponent(version)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS), redirect: "follow" });
    if (res.status === 404) return false;
    if (!res.ok) throw new UpdateSourceError(`${url} returned HTTP ${res.status}`);
    return true;
  } catch (e) {
    if (e instanceof UpdateSourceError) throw e;
    throw new UpdateSourceError(`cannot reach ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface NpmInvocation {
  /** The executable to spawn. Never a shell. */
  command: string;
  /** Everything before the npm subcommand, e.g. the path to npm-cli.js. */
  prefix: string[];
}

function which(name: string): string | undefined {
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}

/**
 * How to run npm without a shell.
 *
 * Preferring npm's own `npm-cli.js` over the `npm` wrapper is what makes that
 * possible on Windows: since the 2024 fix for CVE-2024-27980, Node refuses to
 * spawn a `.cmd` without `shell: true`, and turning the shell on would mean
 * the package name and version were parsed by cmd.exe. Running the script with
 * this process's own Node interpreter sidesteps the wrapper entirely and is
 * the identical code path on every platform.
 */
export function findNpm(): NpmInvocation {
  const names = process.platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"];
  for (const name of names) {
    const found = which(name);
    if (!found) continue;

    // On Unix the `npm` on PATH is usually a symlink straight to npm-cli.js.
    let resolved = found;
    try {
      resolved = realpathSync(found);
    } catch {
      // Keep the unresolved path.
    }
    if (resolved.endsWith(".js")) return { command: process.execPath, prefix: [resolved] };

    // Otherwise look for the CLI script beside the wrapper, which is where
    // every npm layout (Windows, nvm, Homebrew, Volta) puts it.
    for (const relative of [
      ["node_modules", "npm", "bin", "npm-cli.js"],
      ["..", "lib", "node_modules", "npm", "bin", "npm-cli.js"],
    ]) {
      const cli = path.join(path.dirname(resolved), ...relative);
      if (existsSync(cli)) return { command: process.execPath, prefix: [cli] };
    }

    // A wrapper we cannot see through. Safe to spawn directly everywhere
    // except Windows, where Node will refuse a .cmd without a shell — and a
    // shell is not something this command is willing to introduce.
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) continue;
    return { command: resolved, prefix: [] };
  }

  throw new UpdateSourceError(
    `no npm executable was found on PATH, so this npm install cannot be updated from here.\n` +
      `  Update it directly with:  npm install -g ${PACKAGE_NAME}@latest`,
  );
}

export const installArgs = (version: string): string[] => [
  "install",
  "--global",
  `${PACKAGE_NAME}@${version}`,
];

/**
 * Where npm's own stdout should go.
 *
 * `inherit` is right for an interactive run: npm's progress, prompts and
 * errors reach the terminal unmediated. It is wrong under `--json`, where
 * this command's stdout is a machine-readable document and npm writing its
 * own lines into it produces something no parser can read. Passed in
 * explicitly rather than read off a global, so the one caller that knows
 * which mode it is in is the one that decides.
 */
export type NpmOutput = "inherit" | "stderr";

/**
 * Run `npm install -g <pkg>@<exact>` and return its exit code.
 *
 * Arguments go across as an array with `shell: false`, so the version string
 * is an argument rather than something a shell re-parses. npm's stderr is
 * always inherited — a failing install has to be able to say why — and only
 * its stdout is diverted, onto this process's stderr rather than discarded,
 * so `--json` loses none of the diagnosis it would otherwise print.
 */
export function runNpmInstall(
  npm: NpmInvocation,
  version: string,
  output: NpmOutput = "inherit",
): Promise<number> {
  if (!isStrictSemver(version)) {
    // Belt and braces: nothing should reach here with an unvalidated version.
    throw new UpdateSourceError(`refusing to install '${version}': not a version`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(npm.command, [...npm.prefix, ...installArgs(version)], {
      stdio: npmStdio(output),
      shell: false,
    });
    // "pipe" only ever means "send it to stderr instead": nothing is dropped.
    child.stdout?.pipe(process.stderr);
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** stdin, stdout, stderr — separated out so the contract can be asserted. */
export const npmStdio = (output: NpmOutput): ("inherit" | "pipe" | "ignore")[] => [
  "inherit",
  output === "stderr" ? "pipe" : "inherit",
  "inherit",
];

/**
 * What is globally installed now, asked of npm rather than inferred.
 *
 * The running copy's own package.json is the fallback and not the primary
 * answer: `npm install -g` writes to npm's global prefix, which is not
 * necessarily the tree this process was loaded from.
 */
export function installedGlobalVersion(npm: NpmInvocation, packageDir: string): string | undefined {
  const listed = npmLsVersion(npm);
  if (listed) return listed;
  try {
    return (JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as { version?: string })
      .version;
  } catch {
    return undefined;
  }
}

function npmLsVersion(npm: NpmInvocation): string | undefined {
  const r = spawnSync(npm.command, [...npm.prefix, "ls", "--global", "--depth", "0", "--json", PACKAGE_NAME], {
    encoding: "utf8",
    shell: false,
    timeout: 60_000,
  });
  if (!r.stdout) return undefined;
  try {
    const doc = JSON.parse(r.stdout) as { dependencies?: Record<string, { version?: string }> };
    return doc.dependencies?.[PACKAGE_NAME]?.version;
  } catch {
    return undefined;
  }
}
