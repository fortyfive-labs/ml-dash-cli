/**
 * `ml-dash update` — update this install, in place, from wherever it came.
 *
 * Two channels ship ml-dash and they are updated in completely different ways,
 * so the first thing this does is work out which one is running (see
 * src/update/channel.ts) and refuse if the answer is "neither" — a source
 * checkout must not quietly rewrite somebody's global install.
 *
 *   npm         ask registry.npmjs.org for dist-tags.latest, then run
 *               `npm install -g @dreamlake/ml-dash@<exact>` and re-read what
 *               npm actually left installed.
 *   standalone  read the `latest` pointer and the release manifest from the
 *               same bucket the binary was installed from, download this
 *               platform's build, check its size and sha256 against the
 *               manifest, run it once, and only then rename it over the
 *               running binary.
 *
 * Failure at any point leaves the installed binary untouched and removes the
 * download. Nothing is ever written next to the binary before its checksum has
 * been verified.
 */
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import type { CommandSpec, ParsedArgs } from "../cli/parser.js";
import { bold, cyan, dim, green, red, yellow } from "../util/ansi.js";
import { VERSION } from "../version.js";
import { detectChannel, PACKAGE_NAME, type Channel } from "../update/channel.js";
import { detectPlatform, UnsupportedPlatformError } from "../update/platform.js";
import {
  binaryUrl,
  downloadTo,
  entryFor,
  isStrictSemver,
  readChannelVersion,
  readManifest,
  resolveBaseUrl,
  UpdateSourceError,
} from "../update/release.js";
import {
  findNpm,
  installedGlobalVersion,
  latestPublishedVersion,
  resolveRegistry,
  runNpmInstall,
  versionExists,
} from "../update/npm.js";
import { checkReplaceable, ReplaceError, scheduleWindowsSwap, swapInPlace } from "../update/replace.js";

export const spec: CommandSpec = {
  name: "update",
  help: "Update ml-dash to the latest version",
  description:
    "Check for a newer ml-dash and install it.\n\n" +
    "The update uses whichever channel this copy was installed from: an npm\n" +
    "install is updated with 'npm install -g', a standalone binary replaces\n" +
    "itself with the build published for this platform. A standalone download\n" +
    "is checked against the sha256 in the release manifest and run once before\n" +
    "it replaces anything, so a bad download leaves the working binary in place.",
  options: [
    { flags: ["--check"], dest: "check", boolean: true, help: "Report whether an update exists; change nothing" },
    { flags: ["--version"], dest: "version", metavar: "VERSION", help: "Install this exact version instead of the latest" },
    { flags: ["--json"], dest: "json", boolean: true, help: "Output as JSON" },
  ],
};

type Action = "up-to-date" | "available" | "updated" | "scheduled";

interface Report {
  channel: "npm" | "standalone";
  current: string;
  target: string;
  update_available: boolean;
  action: Action;
  /** Only when the action left something for after this process exits. */
  note?: string;
}

const emit = (report: Report, json: boolean, human: string[]): number => {
  if (json) console.log(JSON.stringify(report, null, 2));
  else for (const line of human) console.log(line);
  return 0;
};

const fail = (message: string, json: boolean): number => {
  if (json) console.log(JSON.stringify({ error: message }, null, 2));
  else console.error(`${red("✗ Update failed:")} ${message}`);
  return 1;
};

export async function run(args: ParsedArgs): Promise<number> {
  const json = args.json === true;
  const check = args.check === true;

  const pinned = typeof args.version === "string" ? args.version.trim().replace(/^v/, "") : undefined;
  if (pinned !== undefined && !isStrictSemver(pinned)) {
    return fail(`'${String(args.version)}' is not a version — expected something like 0.1.1`, json);
  }

  const channel = detectChannel();
  if (channel.kind === "source") {
    return fail(
      `this is not an installed ml-dash — ${channel.reason}.\n` +
        `  There is nothing here to replace, and updating the copy on your PATH from a\n` +
        `  checkout would change an install this process does not own. To update that\n` +
        `  copy, run 'ml-dash update' from it instead.`,
      json,
    );
  }

  try {
    return channel.kind === "npm"
      ? await updateNpm(channel, { check, pinned, json })
      : await updateStandalone(channel, { check, pinned, json });
  } catch (e) {
    if (e instanceof UpdateSourceError || e instanceof ReplaceError || e instanceof UnsupportedPlatformError) {
      return fail(e.message, json);
    }
    throw e;
  }
}

interface Options {
  check: boolean;
  pinned?: string;
  json: boolean;
}

/**
 * Decide what `target` means relative to what is installed.
 *
 * A downgrade is refused rather than performed. `update` is the command people
 * run to move forward, and it is also the command a script runs unattended;
 * silently installing an older build because a pointer moved backwards is the
 * one outcome nobody asks for. Installing an older version deliberately is
 * what install.sh --version is for, and the message says so.
 */
function compareOrThrow(current: string, target: string): "same" | "newer" {
  if (!semver.valid(current)) throw new UpdateSourceError(`this build reports version '${current}'`);
  if (semver.eq(target, current)) return "same";
  if (semver.lt(target, current)) {
    throw new UpdateSourceError(
      `${target} is older than the installed ${current}, and update does not downgrade.\n` +
        `  To install an older build deliberately:\n` +
        `      curl -fsSL https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev/install.sh | sh -s -- --version ${target}`,
    );
  }
  return "newer";
}

// ── npm ──────────────────────────────────────────────────────────────────────

async function updateNpm(channel: Extract<Channel, { kind: "npm" }>, opts: Options): Promise<number> {
  const { url: registry, overridden } = resolveRegistry();
  if (overridden) console.error(yellow(`note: using registry ${registry} (ML_DASH_UPDATE_REGISTRY)`));

  const target = opts.pinned ?? (await latestPublishedVersion(registry));
  if (opts.pinned && !(await versionExists(registry, opts.pinned))) {
    throw new UpdateSourceError(`${PACKAGE_NAME}@${opts.pinned} is not published on ${registry}`);
  }
  const relation = compareOrThrow(VERSION, target);

  const base: Report = {
    channel: "npm",
    current: VERSION,
    target,
    update_available: relation === "newer",
    action: relation === "same" ? "up-to-date" : "available",
  };

  if (relation === "same") {
    return emit(base, opts.json, [`${green("✓")} ml-dash ${VERSION} is the latest version on npm.`]);
  }
  if (opts.check) {
    return emit(base, opts.json, [
      `${yellow("↑")} ml-dash ${cyan(target)} is available — you have ${VERSION}.`,
      `  Install it with: ${bold("ml-dash update")}`,
    ]);
  }

  const npm = findNpm();
  if (!opts.json) console.log(`Updating ml-dash ${VERSION} → ${cyan(target)} via npm`);
  const code = await runNpmInstall(npm, target);
  if (code !== 0) {
    throw new UpdateSourceError(
      `npm install exited ${code}. Nothing here changed the install; npm's own output above says why.\n` +
        `  A global install often needs elevated permissions — see 'npm config get prefix'.`,
    );
  }

  // npm exiting 0 is not the same as the right version being installed: a
  // global prefix this process cannot see, or an install that resolved a
  // different tree, would both exit 0 and leave the old binary on PATH.
  const now = installedGlobalVersion(npm, channel.packageDir);
  if (now !== target) {
    throw new UpdateSourceError(
      `npm reported success, but the globally installed version is ${now ?? "unreadable"}, not ${target}.\n` +
        `  Check which ml-dash is first on your PATH: 'npm ls -g ${PACKAGE_NAME}' and 'which ml-dash'.`,
    );
  }

  return emit({ ...base, action: "updated" }, opts.json, [
    "",
    `${green("✓ Updated to ml-dash " + target)}`,
    dim(`  npm reports ${PACKAGE_NAME}@${now} installed globally.`),
  ]);
}

// ── standalone ───────────────────────────────────────────────────────────────

async function updateStandalone(
  channel: Extract<Channel, { kind: "standalone" }>,
  opts: Options,
): Promise<number> {
  const { url: baseUrl, overridden } = resolveBaseUrl();
  if (overridden) console.error(yellow(`note: updating from ${baseUrl} (ML_DASH_UPDATE_BASE_URL)`));

  const platform = detectPlatform();
  const target = opts.pinned ?? (await readChannelVersion(baseUrl, "latest"));
  const relation = compareOrThrow(VERSION, target);

  const base: Report = {
    channel: "standalone",
    current: VERSION,
    target,
    update_available: relation === "newer",
    action: relation === "same" ? "up-to-date" : "available",
  };

  if (relation === "same") {
    return emit(base, opts.json, [`${green("✓")} ml-dash ${VERSION} is the latest ${platform} release.`]);
  }
  if (opts.check) {
    return emit(base, opts.json, [
      `${yellow("↑")} ml-dash ${cyan(target)} is available for ${platform} — you have ${VERSION}.`,
      `  Install it with: ${bold("ml-dash update")}`,
    ]);
  }

  const manifest = await readManifest(baseUrl, target);
  const entry = entryFor(manifest, platform);
  const executable = channel.executable;
  await checkReplaceable(executable);

  const source = binaryUrl(baseUrl, target, platform, entry.binary);
  // Staged in the install directory so the last step is a rename within one
  // filesystem, and named after this pid so two concurrent updates cannot
  // write the same file.
  const staged = path.join(path.dirname(executable), `.ml-dash.update.${process.pid}.tmp`);
  let handedOff = false;

  try {
    if (!opts.json) console.log(`Updating ml-dash ${VERSION} → ${cyan(target)} (${platform})`);
    const sha = await downloadTo(source, staged, entry.size);
    if (sha !== entry.checksum) {
      throw new UpdateSourceError(
        `checksum mismatch — the download is not the published ${target} build.\n` +
          `  expected ${entry.checksum}\n` +
          `  got      ${sha}\n` +
          `  Nothing was installed; ${VERSION} is still in place.`,
      );
    }
    if (!opts.json) console.log(`  ${green("sha256 ok")}`);
    smokeTest(staged, target);

    if (process.platform === "win32") {
      // Windows keeps an image section open on a running .exe, so the rename
      // has to happen after this process is gone.
      await scheduleWindowsSwap({ target: executable, staged, version: target, platform, sha256: sha, source });
      handedOff = true;
      return emit({ ...base, action: "scheduled", note: "applied when this command exits" }, opts.json, [
        "",
        `${green("✓ ml-dash " + target + " is verified and ready.")}`,
        `  It replaces the running binary as this command exits — your next ${bold("ml-dash")} is ${target}.`,
      ]);
    }

    await swapInPlace({ target: executable, staged, version: target, platform, sha256: sha, source });
    handedOff = true;
    return emit({ ...base, action: "updated" }, opts.json, [
      "",
      `${green("✓ Updated to ml-dash " + target)}`,
      dim(`  ${executable}`),
    ]);
  } finally {
    // On every failure, and on Windows never: the helper still needs the file.
    if (!handedOff) await rm(staged, { force: true });
  }
}

/**
 * Run the downloaded binary before trusting it, the same gate install.sh
 * applies. A correctly hashed build for the wrong libc is a real outcome —
 * Bun's musl binaries need libstdc++, which Alpine does not ship — and it
 * would otherwise surface as a broken ml-dash at the user's next command
 * rather than here, with the working binary still in place.
 */
function smokeTest(staged: string, expected: string): void {
  const r = spawnSync(staged, ["version"], { encoding: "utf8", shell: false, timeout: 60_000 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.status !== 0) {
    throw new UpdateSourceError(
      `the downloaded ${expected} binary does not run on this system:\n` +
        `${output.split("\n").map((l) => `    ${l}`).join("\n")}\n` +
        `  Nothing was installed.`,
    );
  }
  if (!output.includes(expected)) {
    throw new UpdateSourceError(
      `the downloaded binary reports '${output}' rather than ${expected} — refusing to install it.`,
    );
  }
}
