/**
 * The platform key a release manifest is indexed by.
 *
 * These are the same eight keys `scripts/build-release.ts` builds and the same
 * rules `install.sh` and `install.ps1` apply when they pick one — including the
 * musl suffix, because a glibc binary does not start on Alpine at all. A
 * divergence here would not fail loudly: it would download a real, correctly
 * hashed binary for the wrong libc and only break at the next run.
 */
import { existsSync, readdirSync } from "node:fs";

/** Every key `scripts/build-release.ts` emits. Used to validate a manifest. */
export const PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "windows-x64",
  "windows-arm64",
] as const;

export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export class UnsupportedPlatformError extends Error {}

/**
 * Probed rather than assumed, matching install.sh: `ldd --version | grep musl`
 * is the shell's version of this, and the loader's own file name is the same
 * evidence without a subprocess. `/etc/alpine-release` is a second signal for
 * the case where /lib is not readable.
 */
function isMusl(): boolean {
  try {
    if (readdirSync("/lib").some((f) => f.startsWith("ld-musl-"))) return true;
  } catch {
    // /lib unreadable or absent; fall through to the distro marker.
  }
  return existsSync("/etc/alpine-release");
}

export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: () => boolean = isMusl,
): PlatformKey {
  let os: string;
  switch (platform) {
    case "darwin":
      os = "darwin";
      break;
    case "linux":
      os = "linux";
      break;
    case "win32":
      os = "windows";
      break;
    default:
      throw new UnsupportedPlatformError(
        `ml-dash has no build for '${platform}'. Supported: macOS, Linux and Windows.`,
      );
  }

  let cpu: string;
  switch (arch) {
    case "x64":
      cpu = "x64";
      break;
    case "arm64":
      cpu = "arm64";
      break;
    default:
      throw new UnsupportedPlatformError(
        `ml-dash has no build for '${arch}'. Supported architectures: x64 and arm64.`,
      );
  }

  const key = os === "linux" && musl() ? `linux-${cpu}-musl` : `${os}-${cpu}`;
  return key as PlatformKey;
}
