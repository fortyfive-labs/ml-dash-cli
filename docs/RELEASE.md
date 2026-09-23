# Releasing ml-dash

Two channels, one source tree: `src/index.ts` is compiled ahead of time into
per-platform binaries for the R2 channel, and to `dist/` by `tsc` for the npm
channel. There is no second implementation to drift.

## Commands

```sh
bun run scripts/build-release.ts                     # all eight targets
bun run scripts/build-release.ts --targets=darwin-arm64,linux-x64
bun run scripts/build-release.ts --public-url=https://pub-xxxx.r2.dev
./scripts/publish-release.sh 0.1.0                   # R2 + npm, move `latest`
./scripts/publish-release.sh 0.1.0 --stable          # also move `stable`
./scripts/publish-release.sh 0.1.0 --verify-only     # re-check, upload nothing
```

The build produces **every** artifact a release publishes; the publish step
produces none:

```
release/<version>/<platform>/ml-dash[.exe]   compiled binaries
release/<version>/ml-dash-<version>.tgz      npm package, packed at build time
release/<version>/install.sh, install.ps1    installers, base URL baked in
release/<version>/manifest.json              sha256 + size of all of the above,
                                             plus source commit, bun version
                                             and the public base URL
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

- **What ships is what was reviewed.** `publish-release.sh` compiles nothing,
  runs no `npm run build` and no `npm pack`. It re-hashes every file in
  `release/<version>/` against the manifest, checks the tarball's own
  `package.json` version, and publishes that tarball by path (`npm publish
  <file>.tgz`) rather than the working directory — publishing a directory
  would re-pack whatever is on disk at publish time, which is a different
  artifact from the reviewed one with no way to tell afterwards. The manifest
  records the source commit (and marks a dirty tree) so the artifacts can be
  traced back.
- **Versions are immutable, retries are not republishes.** Before uploading,
  the published manifest for that version is fetched: identical means a
  half-finished publish is resumed, different means the run aborts rather than
  rewriting bytes someone may already have installed. The same test is applied
  to npm by comparing the registry's `dist.integrity` against the local
  tarball's — a version-string match alone says nothing about contents.
- **Nothing is announced until it is fetchable.** Binaries, tarball, manifest
  and installers upload first; then every one of them is read back over the
  public URL and compared byte-for-byte — including both installer URLs, the
  short `/install.sh` and the prefixed `/ml-dash-cli/install.sh`, since those
  are what README tells people to pipe into a shell. Only after all of that
  does npm publish, and only after that do `latest` / `stable` move. A wrangler exit code is not evidence — an
  upload can report success and leave a 404 behind, which is why pointers move
  last and read themselves back with a cache-busting query.
- **An install is reproducible and verified.** Both installers read the
  manifest, check sha256 and size before writing anything, and stage into the
  install directory so the final step is a rename within one filesystem. A
  pinned `--version` installs identical bytes anywhere.
- **No other installation is touched, and no unowned file is overwritten.** An
  `ml-dash` on PATH from npm or pip is reported and left alone. At the install
  path itself, a matching path is not treated as proof of ownership: the
  installer writes a `.ml-dash.receipt` recording the sha256 it installed, and
  overwrites only when the file still hashes to that value. A symlink, a file
  with no receipt, or one changed since — a pipx shim, a hand-written script,
  another tool's binary — stops the install with instructions instead.
  `--force` / `-Force` takes over deliberately. Re-running the installer over
  its own previous install is the supported upgrade path.
- **The installer fetches from the host that served it.** The public base URL
  is baked into the installer at build time and recorded in the manifest;
  `publish-release.sh` refuses to upload a release to a different origin than
  the one it was built for. A release served from `r2.dev` therefore ships
  installers that fetch from `r2.dev`.
- **Nothing is left behind.** Downloads land in a per-run temp directory, and
  the staged file inside the install directory is tracked by the same handler,
  both removed on success, failure and interrupt alike. The publish script uses
  one process-wide cleanup for the same reason: per-function `RETURN` traps
  were tried first and fought with the outer handler, leaving large failed
  downloads behind.

## Observable failures

| What goes wrong | What you see |
| --- | --- |
| Corrupt / substituted object | `size mismatch` or `checksum mismatch`, nothing written |
| Release has no build for the platform | `release X has no build for <platform>` |
| Version not published | `no manifest at .../manifest.json` |
| Local artifact edited after build | `does not match the manifest — rebuild, do not publish` |
| Stale tarball in the release dir | `<tgz> contains version X, not Y` |
| Version already published, different bytes | `already published with DIFFERENT artifacts` / `on the registry with DIFFERENT bytes` |
| Install path owned by something else | `refusing to overwrite: … has no install receipt` |
| Publishing to another origin | `Manifest was built for … rebuild with --public-url=` |
| Upload that is not fetchable | `remote bytes differ` / `download failed`, pointers never move |
| `src/version.ts` ≠ `package.json` | build refuses to start |

## Verification limits on this host

This is a macOS arm64 machine, so what has actually been exercised here is:

- **Done:** `install.sh` end-to-end against a local HTTP server serving a
  build-shaped manifest — channel-pointer resolution, platform detection,
  sha256+size verification, atomic install, receipt-recognised reinstall, and
  temp/stage cleanup. Refusals proven by direct run, each with the target's
  bytes checked afterwards and found unchanged: a sentinel file at the install
  path, a symlink at the install path, a file replaced since the receipt was
  written, and a tampered download (nothing written at all). `--force` takes
  over and writes the receipt. `publish-release.sh --verify-only` run against
  a fixture release: local digests pass, an artifact edited after the build is
  refused, an edited installer is refused, a stale tarball version is refused,
  a redirected `ML_DASH_PUBLIC_URL` is refused, and an unreachable host fails
  before anything is uploaded or moved. Shell/bash syntax checks on all three
  scripts; the build script parses and resolves under Bun.
- **Not done here:** no build of any kind has been run — no binaries, no
  tarball, no manifest exists yet; the fixtures above were hand-made to the
  manifest's shape. No full eight-platform build (deferred until the source
  tree settles), and no binary has been executed on Linux glibc, Linux musl,
  Windows x64 or Windows ARM64. Cross-compiled output and the three non-macOS
  platforms are unproven by execution on real hardware — Windows ARM64 most of
  all, since nothing here can run it. `install.ps1` has not been parsed or run:
  no PowerShell on this machine.

Treat a first release as needing one real run per platform before `stable`
moves. `--no-pointer` publishes a version that only a pinned `--version` install
can reach, which is the way to do that.

## Prerequisites still open

- **Cloudflare access works; the bucket does not exist.** `npx wrangler
  whoami` succeeds against a stored OAuth login on this machine, and `wrangler
  r2 bucket list` returns the account's buckets — `dreamlake-downloads` and
  `lakeshore-releases`. There is no `dash-downloads`; creating it, and turning
  on public access for it, are release-authorization steps that were not taken
  here. (The first `r2 bucket list` failed with `fetch failed`; a retry
  succeeded, so treat a single connectivity error during publish as worth one
  retry — but never treat an upload's exit code as proof, which is what the
  read-back gate is for.)
- **`dl.dash.ml` does not resolve, and `dash.ml` is not on Cloudflare DNS** —
  its nameservers are NS1 (`dns[1-4].p06.nsone.net`). An R2 custom domain needs
  the zone in Cloudflare, so either the zone moves, or a CNAME to the bucket's
  custom-domain endpoint is added at NS1, or the release uses the bucket's
  `*.r2.dev` public URL. Every path is parameterized for that: set
  `ML_DASH_PUBLIC_URL` when publishing and `ML_DASH_BASE_URL` (or `--base-url`)
  when installing, and update the URLs in README.md to match.
- **License: resolved.** `LICENSE` is the MIT text copied verbatim from the
  upstream Python `ml-dash` repository (`Copyright (c) 2025 Ge Yang, Tom Tao`),
  whose `pyproject.toml` declares the same MIT terms for the same project name.
  Nothing was invented and `package.json`'s `"license": "MIT"` already matched,
  so it was left untouched.
- **npm:** logged in as `tomtao57`; the name `ml-dash` is unregistered on the
  registry, so the first publish claims it. Publishing has not been attempted.
