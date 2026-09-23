/**
 * Reading the standalone channel: the pointer, the manifest, and the bytes.
 *
 * This is the download half of install.sh expressed in TypeScript, and it
 * makes the same promises: the origin is fixed at build time, the version is
 * a pointer object published by scripts/publish-release.sh, and nothing is
 * written anywhere until the downloaded bytes match the sha256 and the size
 * the manifest records for this exact platform.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PLATFORM_KEYS, type PlatformKey } from "./platform.js";

/**
 * The bucket the releases are actually served from — the same constant
 * scripts/build-release.ts bakes into the installers, checked against it by
 * that script so the two cannot drift. A binary must not learn where to fetch
 * its own replacement from anywhere but its own build.
 */
export const DEFAULT_PUBLIC_URL = "https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev";
export const RELEASE_PREFIX = "ml-dash-cli/releases";

/** Small documents. A pointer is a version string; a manifest is a few KB. */
const POINTER_MAX_BYTES = 256;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const METADATA_TIMEOUT_MS = 20_000;

/**
 * Binaries are 60–100 MB today. The cap is not the real check — the manifest's
 * own `size` is, and it is enforced byte by byte below — it is the bound that
 * applies before any manifest is trusted at all.
 */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export class UpdateSourceError extends Error {}

/**
 * Where to fetch from.
 *
 * `ML_DASH_UPDATE_BASE_URL` mirrors the `--base-url` / `ML_DASH_BASE_URL`
 * override install.sh and install.ps1 have always documented, so a staging
 * bucket can be tested end to end. It is deliberately narrow: HTTPS only,
 * except for a loopback host, which is how the test fixture injects a local
 * server without opening a hole anywhere a network attacker sits. A caller
 * that overrides it is told so on stderr — an update that came from somewhere
 * other than the official origin must never be silent.
 */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): { url: string; overridden: boolean } {
  const raw = env.ML_DASH_UPDATE_BASE_URL?.trim();
  if (!raw) return { url: DEFAULT_PUBLIC_URL, overridden: false };
  return { url: requireSafeOrigin(raw, "ML_DASH_UPDATE_BASE_URL").replace(/\/+$/, ""), overridden: true };
}

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";

/** HTTPS, or plain HTTP to a loopback address and nothing else. */
export function requireSafeOrigin(value: string, what: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UpdateSourceError(`${what} is not a URL: ${value}`);
  }
  if (parsed.protocol === "https:") return value;
  if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) return value;
  throw new UpdateSourceError(
    `${what} must be an https:// URL (got ${parsed.protocol}//${parsed.hostname}). ` +
      `Plain http is accepted only for a loopback address.`,
  );
}

async function getText(url: string, limit: number, what: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS), redirect: "follow" });
  } catch (e) {
    throw new UpdateSourceError(
      `cannot reach ${url} to read ${what}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // A redirect can leave the origin rule behind, so the URL that actually
  // answered is checked, not just the one that was asked.
  requireSafeOrigin(res.url || url, `the server that answered for ${what}`);
  if (!res.ok) {
    throw new UpdateSourceError(`${url} returned HTTP ${res.status} for ${what}`);
  }
  return readBounded(res, limit, `${what} at ${url}`);
}

/**
 * Read a response body, giving up the moment it passes `limit`.
 *
 * `await res.text()` would buffer the whole thing first and only then let the
 * limit be checked, which makes the limit useless against the case it exists
 * for: a source that answers a 300-byte pointer request with an endless body.
 * The declared Content-Length is rejected first when there is one, and the
 * stream is counted either way, because Content-Length is a claim.
 */
export async function readBounded(res: Response, limit: number, what: string): Promise<string> {
  const tooBig = () => new UpdateSourceError(`${what} is larger than ${limit} bytes — refusing to read it`);

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw tooBig();
  if (!res.body) return "";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > limit) throw tooBig();
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out + decoder.decode();
}

/** Strict semver, the same shape .github/workflows/release.yml accepts. */
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export const isStrictSemver = (v: string): boolean => SEMVER.test(v);

/** The version a channel pointer names, e.g. `.../releases/latest`. */
export async function readChannelVersion(baseUrl: string, channel: string): Promise<string> {
  const url = `${baseUrl}/${RELEASE_PREFIX}/${encodeURIComponent(channel)}`;
  const version = (await getText(url, POINTER_MAX_BYTES, `the '${channel}' channel`)).trim();
  if (!isStrictSemver(version)) {
    throw new UpdateSourceError(
      `the '${channel}' channel at ${url} reads '${version.slice(0, 64)}', which is not a version`,
    );
  }
  return version;
}

export interface PlatformEntry {
  binary: string;
  checksum: string;
  size: number;
}

export interface ReleaseManifest {
  version: string;
  platforms: Record<string, PlatformEntry>;
}

/**
 * A file name and nothing else. The manifest decides what to write next to the
 * running binary, so `../`, an absolute path and a nested path are all refused
 * before the name is ever joined onto a directory.
 */
const isPlainFilename = (name: string): boolean =>
  /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";

export async function readManifest(baseUrl: string, version: string): Promise<ReleaseManifest> {
  if (!isStrictSemver(version)) throw new UpdateSourceError(`'${version}' is not a version`);
  const url = `${baseUrl}/${RELEASE_PREFIX}/${version}/manifest.json`;
  const text = await getText(url, MANIFEST_MAX_BYTES, `the manifest for ${version}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UpdateSourceError(`the manifest at ${url} is not JSON`);
  }
  const m = parsed as { version?: unknown; platforms?: Record<string, Partial<PlatformEntry>> };
  if (m.version !== version) {
    throw new UpdateSourceError(
      `the manifest at ${url} declares version ${String(m.version)}, not ${version}`,
    );
  }
  if (!m.platforms || typeof m.platforms !== "object") {
    throw new UpdateSourceError(`the manifest at ${url} lists no platforms`);
  }

  const platforms: Record<string, PlatformEntry> = {};
  for (const [key, entry] of Object.entries(m.platforms)) {
    if (!(PLATFORM_KEYS as readonly string[]).includes(key)) continue;
    const { binary, checksum, size } = entry ?? {};
    if (typeof binary !== "string" || !isPlainFilename(binary)) {
      throw new UpdateSourceError(`the manifest at ${url} gives ${key} an unusable file name`);
    }
    if (typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum)) {
      throw new UpdateSourceError(`the manifest at ${url} gives ${key} no sha256`);
    }
    if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > MAX_DOWNLOAD_BYTES) {
      throw new UpdateSourceError(`the manifest at ${url} gives ${key} an unusable size (${String(size)})`);
    }
    platforms[key] = { binary, checksum, size };
  }
  return { version, platforms };
}

export function entryFor(manifest: ReleaseManifest, platform: PlatformKey): PlatformEntry {
  const entry = manifest.platforms[platform];
  if (!entry) {
    throw new UpdateSourceError(
      `release ${manifest.version} has no build for ${platform} — it publishes: ` +
        `${Object.keys(manifest.platforms).join(", ") || "nothing"}`,
    );
  }
  return entry;
}

export const binaryUrl = (baseUrl: string, version: string, platform: string, binary: string): string =>
  `${baseUrl}/${RELEASE_PREFIX}/${version}/${platform}/${binary}`;

/**
 * Stream a release binary to `dest`, refusing to write more bytes than the
 * manifest says exist, and return the sha256 of what actually landed.
 *
 * The length is enforced while streaming rather than checked afterwards so a
 * server that answers with an endless body fills no disk.
 */
export async function downloadTo(url: string, dest: string, expectedSize: number): Promise<string> {
  requireSafeOrigin(url, "the download URL");
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "follow" });
  } catch (e) {
    throw new UpdateSourceError(`download failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  requireSafeOrigin(res.url || url, "the server that answered the download");
  if (!res.ok) throw new UpdateSourceError(`${url} returned HTTP ${res.status}`);
  if (!res.body) throw new UpdateSourceError(`${url} returned no body`);

  const hash = createHash("sha256");
  let seen = 0;
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);

  // A path-based stream, deliberately, rather than one wrapped around a
  // FileHandle: when the transform below aborts an over-long download,
  // pipeline() destroys the sink, and a stream that shares an fd with a
  // FileHandle then leaves that handle closed underneath it. Closing it again
  // throws EBADF from the cleanup path and replaces the real error — which is
  // exactly the diagnosis a failed update must not lose. One owner for the fd
  // removes the problem rather than working around it.
  await pipeline(
    body,
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        seen += chunk.length;
        if (seen > expectedSize) {
          throw new UpdateSourceError(
            `download is longer than the ${expectedSize} bytes the manifest declares — stopped`,
          );
        }
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(dest, { flags: "w", mode: 0o700 }),
  );

  // fsync before the caller renames: rename is atomic for the directory entry
  // only, so an unflushed replacement is a truncated binary after a crash.
  const handle = await open(dest, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (seen !== expectedSize) {
    throw new UpdateSourceError(`download is ${seen} bytes, the manifest declares ${expectedSize}`);
  }
  return hash.digest("hex");
}
