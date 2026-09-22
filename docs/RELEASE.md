# Releasing ml-dash

Two channels, one source tree: `src/index.ts` is compiled ahead of time into
per-platform binaries for the R2 channel, and to `dist/` by `tsc` for the npm
channel. There is no second implementation to drift.

## Commands

```sh
bun run scripts/build-release.ts                     # all eight targets
bun run scripts/build-release.ts --targets=darwin-arm64,linux-x64
./scripts/publish-release.sh 0.1.0                   # R2 + npm, move `latest`
./scripts/publish-release.sh 0.1.0 --stable          # also move `stable`
./scripts/publish-release.sh 0.1.0 --verify-only     # re-check, upload nothing
```

Build output — the shape both installers and the publish script read:

```
release/<version>/<platform>/ml-dash[.exe]
release/<version>/manifest.json     # per platform: target, binary, sha256, size
```

## Platforms

| Platform key | `--compile --target` |
| --- | --- |
| `darwin-arm64`, `darwin-x64` | `bun-darwin-arm64`, `bun-darwin-x64` |
| `linux-x64`, `linux-arm64` | `bun-linux-x64`, `bun-linux-arm64` (glibc) |
| `linux-x64-musl`, `linux-arm64-musl` | `bun-linux-*-musl` (Alpine) |
| `windows-x64`, `windows-arm64` | `bun-windows-x64`, `bun-windows-arm64` |

Verified against the Bun on this machine (1.3.14): every one of those target
strings is accepted by `bun build --compile`, and the runtime assets it fetches
for them exist in the `bun-v1.3.14` release — including `bun-windows-aarch64`,
so `windows-arm64` is a real build and not an alias of x64. x64 "baseline"
variants are deliberately not built: current Bun ships a single x64 binary that
picks AVX paths at runtime, so a baseline build would be a duplicate.

## The claims this pipeline makes, and how each is enforced

- **What ships is what was reviewed.** `publish-release.sh` never builds
  binaries. It re-hashes every file in `release/<version>/` against the
  manifest and refuses to upload on any mismatch, so a rebuild after review
  cannot ride out under the reviewed version.
- **Nothing is announced until it is fetchable.** Binaries, manifest and
  installers upload first; then every object is read back over the public URL
  and compared byte-for-byte. Only after that does npm publish, and only after
  that do `latest` / `stable` move. A wrangler exit code is not evidence — an
  upload can report success and leave a 404 behind, which is why pointers move
  last and read themselves back with a cache-busting query.
- **An install is reproducible and verified.** Both installers read the
  manifest, check sha256 and size before writing anything, and stage into the
  install directory so the final step is a rename within one filesystem. A
  pinned `--version` installs identical bytes anywhere.
- **No other installation is touched.** An `ml-dash` on PATH from npm or pip is
  reported and left alone; only this installer's own path is overwritten, which
  makes re-running it the supported way to upgrade in place.
- **Nothing is left behind.** Downloads land in a per-run temp directory removed
  on success, failure and interrupt alike.

## Observable failures

| What goes wrong | What you see |
| --- | --- |
| Corrupt / substituted object | `size mismatch` or `checksum mismatch`, nothing written |
| Release has no build for the platform | `release X has no build for <platform>` |
| Version not published | `no manifest at .../manifest.json` |
| Local artifact edited after build | `does not match the manifest — rebuild, do not publish` |
| Upload that is not fetchable | `remote bytes differ` / `download failed`, pointers never move |
| `src/version.ts` ≠ `package.json` | build refuses to start |

## Verification limits on this host

This is a macOS arm64 machine, so what has actually been exercised here is:

- **Done:** `install.sh` end-to-end against a local HTTP server serving a real
  manifest — channel-pointer resolution, platform detection, sha256+size
  verification, atomic install, same-channel reinstall, rejection of a tampered
  object with nothing written, and temp-directory cleanup. Shell/bash syntax
  checks on all three scripts; the build script parses and resolves under Bun.
- **Not done here:** no full eight-platform build (deferred until the source
  tree settles), and no binary has been executed on Linux glibc, Linux musl,
  Windows x64 or Windows ARM64. Cross-compiled output and the three non-macOS
  platforms are unproven by execution on real hardware — Windows ARM64 most of
  all, since nothing here can run it. `install.ps1` has not been parsed or run:
  no PowerShell on this machine.

Treat a first release as needing one real run per platform before `stable`
moves. `--no-pointer` publishes a version that only a pinned `--version` install
can reach, which is the way to do that.

## Prerequisites still open

- **R2 bucket `dash-downloads` does not exist yet** and has not been checked:
  wrangler is not installed here and no `CLOUDFLARE_API_TOKEN` is in the
  environment, so account access, bucket availability and public-read settings
  are all unverified. Creating it is a release-authorization step.
- **`dl.dash.ml` does not resolve, and `dash.ml` is not on Cloudflare DNS** —
  its nameservers are NS1 (`dns[1-4].p06.nsone.net`). An R2 custom domain needs
  the zone in Cloudflare, so either the zone moves, or a CNAME to the bucket's
  custom-domain endpoint is added at NS1, or the release uses the bucket's
  `*.r2.dev` public URL. Every path is parameterized for that: set
  `ML_DASH_PUBLIC_URL` when publishing and `ML_DASH_BASE_URL` (or `--base-url`)
  when installing, and update the URLs in README.md to match.
- **`LICENSE` file is missing.** `package.json` declares MIT but no license text
  or copyright holder exists in the repo, and inventing one is not a release
  script's call. Add the file (or correct the field) before the first publish.
- **npm:** logged in as `tomtao57`; the name `ml-dash` is unregistered on the
  registry, so the first publish claims it. Publishing has not been attempted.
