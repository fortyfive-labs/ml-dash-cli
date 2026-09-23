/**
 * Which of the two shipping channels is this process?
 *
 * `ml-dash update` must never guess. Updating the npm channel runs
 * `npm install -g`; updating the standalone channel overwrites a file on disk.
 * Doing either from a source checkout would mean a developer running
 * `npm run cli -- update` silently mutates their global install, so a checkout
 * is a third, explicit answer: refuse.
 *
 * The discriminator is exact rather than heuristic:
 *
 *   standalone  `bun build --compile` maps the bundle at `/$bunfs/root/...`,
 *               so `import.meta.url` is under that virtual root while
 *               `process.execPath` is the real single-file binary. Bun running
 *               loose source reports a real path for both, so the two cases
 *               cannot be confused. (Verified against bun 1.3.14 — the version
 *               scripts/build-release.ts pins.)
 *   npm         a Node process whose own module resolves inside a
 *               `node_modules` tree rooted at this package. A checkout has the
 *               same package.json and no such ancestor.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Kept equal to package.json's `name` by a test — the two must not drift. */
export const PACKAGE_NAME = "@dreamlake/ml-dash";

export type Channel =
  | { kind: "standalone"; executable: string }
  | { kind: "npm"; packageDir: string }
  | { kind: "source"; reason: string };

const BUNFS = "/$bunfs/";

/** True when this module was loaded out of a `bun build --compile` bundle. */
export function isCompiledBinary(moduleUrl: string = import.meta.url): boolean {
  return process.versions.bun !== undefined && moduleUrl.includes(BUNFS);
}

/**
 * The package root above `from`, if it is this package installed under a
 * `node_modules` tree. Returns undefined for a checkout, for a different
 * package, and for an unreadable or malformed package.json.
 */
function npmPackageDir(from: string): string | undefined {
  let dir = from;
  for (let depth = 0; depth < 10; depth++) {
    const manifest = path.join(dir, "package.json");
    let name: unknown;
    try {
      name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
      continue;
    }
    if (name !== PACKAGE_NAME) return undefined;
    // A checkout has this package.json too. Only an installed copy sits inside
    // a node_modules tree, and that — not the file's contents — is what makes
    // `npm install -g` the right thing to run.
    return dir.split(path.sep).includes("node_modules") ? dir : undefined;
  }
  return undefined;
}

export function detectChannel(moduleUrl: string = import.meta.url): Channel {
  if (isCompiledBinary(moduleUrl)) {
    return { kind: "standalone", executable: process.execPath };
  }
  if (moduleUrl.includes(BUNFS)) {
    // Bun-mapped but not a compiled binary: nothing here knows what to update.
    return { kind: "source", reason: "running from a bundled source tree" };
  }

  let here: string;
  try {
    here = path.dirname(fileURLToPath(moduleUrl));
  } catch {
    return { kind: "source", reason: "this build has no resolvable install path" };
  }

  const packageDir = npmPackageDir(here);
  if (packageDir) return { kind: "npm", packageDir };

  return {
    kind: "source",
    reason: process.versions.bun
      ? "running from a source checkout under bun"
      : "running from a source checkout, not an installed package",
  };
}
