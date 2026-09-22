#!/usr/bin/env bun
/**
 * Compile the CLI into single-file binaries, one per platform.
 *
 *   bun run scripts/build-release.ts                    # every target
 *   bun run scripts/build-release.ts --targets=darwin-arm64,linux-x64
 *   bun run scripts/build-release.ts --out=release
 *
 * Output layout — the same shape install.sh and publish-release.sh read:
 *
 *   release/<version>/<platform>/ml-dash[.exe]
 *   release/<version>/manifest.json
 *
 * The binaries embed the Bun runtime, so an install needs no Node, no npm and
 * no Python on the target machine. Entry point is src/index.ts — the exact
 * source the npm channel compiles with tsc, so the two channels cannot drift
 * into two implementations.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "src/index.ts");

/**
 * Platform key → `bun build --compile --target`.
 *
 * Verified against this machine's Bun (`bun --version` is recorded in the
 * manifest) and against the runtime assets published for it: bun 1.3.14 ships
 * bun-windows-aarch64.zip, which is what the cross-compile downloader fetches
 * for `bun-windows-arm64`, so Windows ARM64 is a real target rather than an
 * alias of x64. It is still the one platform no one here can execute — see
 * docs/RELEASE.md for what that leaves unproven.
 *
 * musl variants are separate keys because a glibc binary does not run on
 * Alpine at all; install.sh picks between them by probing for musl.
 * x64 "baseline" targets are deliberately absent: current Bun ships one x64
 * binary that selects AVX paths at runtime, so a baseline build would be a
 * byte-identical duplicate under a second name.
 */
const TARGETS: Record<string, string> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64-musl": "bun-linux-x64-musl",
  "linux-arm64-musl": "bun-linux-arm64-musl",
  "windows-x64": "bun-windows-x64",
  "windows-arm64": "bun-windows-arm64",
};

interface ManifestEntry {
  target: string;
  binary: string;
  checksum: string;
  size: number;
}

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function main(): Promise<number> {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  const version = pkg.version;

  // src/version.ts is what `ml-dash version` prints. Rather than rewriting it
  // at build time — which would edit tracked source on every build, and race
  // anyone editing src/ — the build refuses to run when it disagrees with
  // package.json. A binary that misreports its own version is worse than a
  // failed build: it makes every later bug report point at the wrong release.
  const versionSrc = await readFile(join(ROOT, "src/version.ts"), "utf8");
  const declared = /VERSION\s*=\s*"([^"]+)"/.exec(versionSrc)?.[1];
  if (declared !== version) {
    console.error(
      `src/version.ts declares ${declared ?? "<unparseable>"} but package.json is ${version}.\n` +
        `Make them match before building — the compiled binary reports src/version.ts.`,
    );
    return 1;
  }

  const requested = flag("targets")?.split(",").map((t) => t.trim()).filter(Boolean) ?? Object.keys(TARGETS);
  const unknown = requested.filter((t) => !(t in TARGETS));
  if (unknown.length) {
    console.error(`Unknown target(s): ${unknown.join(", ")}\nKnown: ${Object.keys(TARGETS).join(", ")}`);
    return 1;
  }

  const outRoot = resolve(ROOT, flag("out") ?? "release", version);
  // A stale binary left from an earlier attempt would be uploaded as if it
  // were part of this build, so the version directory starts empty.
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(outRoot, { recursive: true });

  const bunVersion = Bun.version;
  console.log(`Building ${pkg.name} ${version} with bun ${bunVersion} → ${outRoot}`);

  const platforms: Record<string, ManifestEntry> = {};
  for (const platform of requested) {
    const target = TARGETS[platform]!;
    const binary = platform.startsWith("windows") ? "ml-dash.exe" : "ml-dash";
    const outfile = join(outRoot, platform, binary);
    await mkdir(join(outRoot, platform), { recursive: true });

    process.stdout.write(`  → ${platform} (${target}) `);
    const proc = Bun.spawn(
      ["bun", "build", "--compile", `--target=${target}`, `--outfile=${outfile}`, ENTRY],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      console.log("failed");
      console.error(await new Response(proc.stderr).text());
      return 1;
    }
    // Bun exiting 0 is not proof that a file landed where it was asked to
    // put one; stat it before it becomes a manifest entry.
    const info = await stat(outfile).catch(() => null);
    if (!info || info.size === 0) {
      console.log("failed");
      console.error(`  ${target} exited 0 but produced no usable file at ${outfile}`);
      return 1;
    }
    platforms[platform] = { target, binary, checksum: await sha256(outfile), size: info.size };
    console.log(`${(info.size / 1e6).toFixed(1)} MB`);
  }

  const manifest = {
    name: pkg.name,
    version,
    built: new Date().toISOString(),
    bun: bunVersion,
    platforms,
  };
  await writeFile(join(outRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\n${Object.keys(platforms).length} binaries + manifest.json in ${outRoot}`);
  console.log(`Publish with: ./scripts/publish-release.sh ${version}`);
  return 0;
}

process.exit(await main());
