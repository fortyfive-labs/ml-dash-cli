#!/usr/bin/env bun
/**
 * Build every artifact a release publishes, and record a digest of each one.
 *
 *   bun run scripts/build-release.ts
 *   bun run scripts/build-release.ts --targets=darwin-arm64,linux-x64
 *   bun run scripts/build-release.ts --public-url=https://pub-xxxx.r2.dev
 *
 * Output — the only thing scripts/publish-release.sh is allowed to publish:
 *
 *   release/<version>/<platform>/ml-dash[.exe]   compiled binaries
 *   release/<version>/<pkg>-<version>.tgz        the npm package, packed here
 *   release/<version>/install.sh, install.ps1    installers, base URL baked in
 *   release/<version>/manifest.json              sha256 + size of all of them
 *
 * Everything that ships is produced here and hashed here. The publish step
 * re-checks those hashes and uploads the bytes as they are: it never compiles,
 * never runs `npm pack`, and so cannot substitute an unreviewed build for the
 * one that was reviewed.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "src/index.ts");

/**
 * Platform key → `bun build --compile --target`.
 *
 * Verified against this machine's Bun (recorded in the manifest): each target
 * string is accepted, and the runtime asset it downloads exists in that Bun
 * release — including bun-windows-aarch64, so windows-arm64 is a real build
 * rather than an alias of x64. It is also the one platform nothing here can
 * execute; docs/RELEASE.md says what that leaves unproven.
 *
 * musl variants are separate keys because a glibc binary does not start on
 * Alpine at all. x64 "baseline" targets are deliberately absent: current Bun
 * ships one x64 binary that selects AVX paths at runtime, so a baseline build
 * would be a byte-identical duplicate under a second name.
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

// The bucket's public r2.dev URL, which is what dash-downloads actually
// serves today: dash.ml is on NS1 nameservers, and an R2 custom domain needs
// the zone in Cloudflare, so dl.dash.ml cannot be pointed here without moving
// DNS. Pass --public-url=https://dl.dash.ml once that changes; the value is
// baked into the installers and recorded in the manifest either way.
const DEFAULT_PUBLIC_URL = "https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev";

interface Digest {
  checksum: string;
  size: number;
}

function flag(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function run(cmd: string[], cwd = ROOT): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code})\n${err || out}`);
  return out;
}

async function digest(path: string): Promise<Digest> {
  const info = await stat(path);
  if (info.size === 0) throw new Error(`${path} is empty`);
  return { checksum: createHash("sha256").update(await readFile(path)).digest("hex"), size: info.size };
}

async function main(): Promise<number> {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { name: string; version: string };
  const version = pkg.version;

  // src/version.ts is what `ml-dash version` prints. Rather than rewriting it
  // — which would edit tracked source on every build — the build refuses when
  // it disagrees with package.json. A binary that misreports its own version
  // makes every later bug report point at the wrong release.
  const declared = /VERSION\s*=\s*"([^"]+)"/.exec(await readFile(join(ROOT, "src/version.ts"), "utf8"))?.[1];
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

  // The base URL the installers will ship with. An install command published
  // for one host must not quietly fetch from another, so whatever the release
  // is actually served from is baked in here and recorded in the manifest;
  // publish-release.sh refuses to upload to a different one.
  const publicUrl = (flag("public-url") ?? process.env.ML_DASH_PUBLIC_URL ?? DEFAULT_PUBLIC_URL).replace(/\/+$/, "");

  const outRoot = resolve(ROOT, flag("out") ?? "release", version);
  // A leftover file from an earlier attempt would otherwise be published as if
  // it belonged to this build.
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(outRoot, { recursive: true });

  let commit = "unknown";
  try {
    commit = (await run(["git", "rev-parse", "HEAD"])).trim();
    if ((await run(["git", "status", "--porcelain"])).trim()) commit += "-dirty";
  } catch {
    // Not a git checkout; the manifest says "unknown" rather than lying.
  }

  console.log(`Building ${pkg.name} ${version} with bun ${Bun.version} → ${outRoot}`);
  console.log(`  source commit ${commit}, install base URL ${publicUrl}`);

  // ── binaries ───────────────────────────────────────────────────────────────
  const platforms: Record<string, Digest & { target: string; binary: string }> = {};
  for (const platform of requested) {
    const target = TARGETS[platform]!;
    const binary = platform.startsWith("windows") ? "ml-dash.exe" : "ml-dash";
    const outfile = join(outRoot, platform, binary);
    await mkdir(join(outRoot, platform), { recursive: true });

    process.stdout.write(`  → ${platform} (${target}) `);
    try {
      await run(["bun", "build", "--compile", `--target=${target}`, `--outfile=${outfile}`, ENTRY]);
      // Bun exiting 0 is not proof a file landed: stat before it becomes a
      // manifest entry.
      platforms[platform] = { target, binary, ...(await digest(outfile)) };
    } catch (e) {
      console.log("failed");
      console.error(`  ${e instanceof Error ? e.message : e}`);
      return 1;
    }
    console.log(`${(platforms[platform]!.size / 1e6).toFixed(1)} MB`);
  }

  // ── npm tarball ────────────────────────────────────────────────────────────
  // Packed here, once, and published byte-for-byte later. `npm publish` on a
  // directory would re-pack whatever is on disk at publish time — a different
  // artifact from the reviewed one, with no way to tell after the fact.
  process.stdout.write("  → npm tarball ");
  await run(["npm", "run", "build"]);
  if (!(await stat(join(ROOT, "dist/index.js")).catch(() => null))) {
    console.log("failed");
    console.error("  dist/index.js missing after `npm run build` — bin/ml-dash.js imports it");
    return 1;
  }
  await run(["npm", "pack", "--pack-destination", outRoot]);
  // Found by extension rather than by a composed name: npm flattens a scoped
  // package to `<scope>-<name>-<version>.tgz`, so `@dreamlake/ml-dash` packs as
  // `dreamlake-ml-dash-0.1.0.tgz`. The directory was emptied above, so there is
  // exactly one candidate and the manifest records whatever npm actually wrote.
  const packed = (await readdir(outRoot)).find((f) => f.endsWith(".tgz"));
  if (!packed) {
    console.log("failed");
    console.error("  npm pack produced no .tgz");
    return 1;
  }
  const npmEntry = { tarball: packed, ...(await digest(join(outRoot, packed))) };
  console.log(`${packed} (${(npmEntry.size / 1e3).toFixed(0)} KB)`);

  // ── installers ─────────────────────────────────────────────────────────────
  // Copied into the release with the chosen base URL substituted for the
  // default, so the uploaded installer is the hashed one and points at the
  // host this release is actually served from.
  const installers: Record<string, Digest> = {};
  for (const name of ["install.sh", "install.ps1"]) {
    const dest = join(outRoot, name);
    await copyFile(join(ROOT, name), dest);
    if (publicUrl !== DEFAULT_PUBLIC_URL) {
      const patched = (await readFile(dest, "utf8")).split(DEFAULT_PUBLIC_URL).join(publicUrl);
      if (!patched.includes(publicUrl)) {
        console.error(`  cannot bake ${publicUrl} into ${name}: default URL not found`);
        return 1;
      }
      await writeFile(dest, patched);
    }
    installers[name] = await digest(dest);
  }
  console.log(`  → install.sh, install.ps1`);

  const manifest = {
    name: pkg.name,
    version,
    built: new Date().toISOString(),
    bun: Bun.version,
    commit,
    publicUrl,
    platforms,
    npm: npmEntry,
    installers,
  };
  await writeFile(join(outRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\n${Object.keys(platforms).length} binaries + npm tarball + installers + manifest.json`);
  if (commit.endsWith("-dirty")) console.log("note: built from a dirty tree — the manifest records that");
  console.log(`Publish with: ./scripts/publish-release.sh ${version}`);
  return 0;
}

process.exit(await main());
