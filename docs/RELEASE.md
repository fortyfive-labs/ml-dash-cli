# Releasing ml-dash

Two channels, one source tree: `src/index.ts` is compiled ahead of time into
per-platform binaries for the R2 channel, and to `dist/` by `tsc` for the npm
channel. There is no second implementation to drift.

## How a release is published

**From CI, not from a laptop.** `.github/workflows/release.yml` is the only
path that is supposed to produce a published `ml-dash`. It checks out a commit
that is already on GitHub, installs a pinned toolchain (Node 24, npm 11.12.1,
Bun 1.3.14 — the Bun the 0.1.0 artifacts were built with), runs `npm test`,
builds all eight targets plus the npm tarball, installers and manifest in one
run, and only then touches a credential. A developer machine cannot be asked to
vouch for bytes nobody else can reproduce.

```sh
gh workflow run release.yml -f version=0.1.0                 # publish 0.1.0
gh workflow run release.yml -f version=0.1.0 -f dry_run=true # build + check, publish nothing
git tag v0.1.0 && git push origin v0.1.0                     # same thing, tag-triggered
```

`-f ref=<sha>` builds an exact commit rather than the dispatched branch. The run
fails before building if `package.json` disagrees with the requested version,
and `build-release.ts` fails before compiling if `src/version.ts` disagrees with
`package.json`.

What a successful run has done, in order:

1. `npm test` passed. (The Python interop suites *skip* on a runner without the
   `ml-dash` virtualenv — they report skipped, not passed.)
2. Eight binaries, `ml-dash-<version>.tgz`, both installers and `manifest.json`
   were built, and the manifest was checked to contain all eight platforms and
   a non-dirty commit.
3. Every artifact was uploaded to R2 and then **read back over the public URL**
   and compared byte-for-byte against the manifest, including both installer
   URLs.
4. `ml-dash@<version>` was published to npm from the tarball packed in step 2 —
   by path, never from the working directory — and the registry's
   `dist.integrity` was compared against sha512 computed from those same bytes.
5. `releases/latest` was moved and read back. **`stable` is not moved**; a
   pinned `--version` install is how a platform gets its first real run.
6. A GitHub Release `v<version>` was created with the manifest, both
   installers, the tarball and all eight binaries, named per platform. It is
   last on purpose: a Release is an announcement, and announcing a publish that
   did not happen is the failure this pipeline is shaped against.

### Secrets the workflow needs

| Name | Where it comes from | Used for |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | the account owning `dash-downloads` | wrangler target account — **set** |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens, a **custom token** scoped to that account with `Workers R2 Storage: Edit` and nothing else | uploading and pointer moves — **not set** |
| `NPM_TOKEN` | npmjs.com → Access Tokens → **Granular access token**, read+write on the `ml-dash` package, no org scope | the first publish only — **not set** |

The npm token is genuinely required for `0.1.0` and genuinely avoidable after
it. npm trusted publishing (OIDC) can only be configured on a package that
already exists — the registry's settings page is the only place to enable it,
and `ml-dash` is an unclaimed name — so the name has to be claimed once with a
token ([npm/cli#8544](https://github.com/npm/cli/issues/8544)). The workflow is
written for both: with `NPM_TOKEN` present it publishes with `--provenance`;
with it absent it performs the OIDC handshake and publishes nothing else
differently. So once `0.1.0` is out, configure the trusted publisher on
npmjs.com (org `fortyfive-labs`, repo `ml-dash-cli`, workflow `release.yml`),
**delete the `NPM_TOKEN` secret and revoke the token**, and later releases need
no npm credential at all. Skipping that last step is the whole point of the
exercise thrown away.

A local `npm login` is deliberately not a dependency of any of this.

### What CI has actually proven so far

One `dry_run=true` run on `ubuntu-latest`
([35813302906](https://github.com/fortyfive-labs/ml-dash-cli/actions/runs/35813302906),
commit `7637326`): `npm test` passed, all eight targets plus the tarball,
installers and manifest built in a single run, and the manifest check passed.
The three publish steps were skipped, as the dry run intends — **nothing has
been published to npm, R2 or Releases by CI or by anyone else.**

Worth recording, because it was not assumed: the eight binaries CI produced are
**byte-identical** to the ones built on a macOS arm64 laptop from a different
commit — `bun build --compile` is reproducible across host and source commit
here, so the R2 artifacts do not depend on which machine builds them. The npm
tarball is *not* byte-identical (55193 vs 55094 bytes; `npm pack` metadata).
Nothing claims it is — the pipeline publishes the tarball CI packed and checks
the registry's `dist.integrity` against those exact bytes — but "reproducible"
applies to the binaries, not to the `.tgz`.

### Re-running a failed release

Safe, and by design. R2 objects and npm versions are immutable, so a re-run of
the *same commit* re-uploads identical bytes (the published manifest is fetched
first; identical means resume, and only a definite 404 means "not published"),
finds `dist.integrity` already equal and skips the npm publish, and re-uploads
the GitHub Release assets with `--clobber`. A re-run of a *different* commit
under the same version is refused at the first check rather than silently
winning. The concurrency group is keyed on the version and does **not**
cancel in progress: interrupting a run between the R2 upload and the npm
publish is the one state that takes a human to untangle.

The scripts below still work by hand, and `--verify-only` is the right way to
re-check a published release from anywhere. They are no longer the way a
release gets published.

## Commands

```sh
bun run scripts/build-release.ts                     # all eight targets
bun run scripts/build-release.ts --targets=darwin-arm64,linux-x64
bun run scripts/build-release.ts --public-url=https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev   # the default
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

## Where it is served from

| | |
| --- | --- |
| R2 bucket | `dash-downloads` (created for this; public access enabled) |
| Public base URL | `https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev` |
| Versioned objects | `<base>/ml-dash-cli/releases/<version>/…` |
| Installers | `<base>/install.sh`, `<base>/ml-dash-cli/install.sh` |

That URL is the build script's default, so the plain command is enough:

```sh
bun run scripts/build-release.ts
```

`dl.dash.ml` is **not** in play. `dash.ml` is served by NS1 nameservers
(`dns[1-4].p06.nsone.net`) and an R2 custom domain requires the zone in
Cloudflare; no DNS was touched. If that changes, rebuild with
`--public-url=https://dl.dash.ml` — the URL is baked into the installers and
recorded in the manifest, and `publish-release.sh` refuses to upload a release
to an origin other than the one it was built for.

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
  the published manifest for that version is fetched, and only a definite HTTP
  404 counts as "not published yet": identical bytes mean a half-finished
  publish is resumed, different bytes abort the run, and a connectivity
  failure, 403 or 5xx also aborts — an unreachable host is not an empty one,
  and treating it as one is how an immutable version gets silently rewritten. The same test is applied
  to npm by comparing the registry's `dist.integrity` against `sha512-<base64>`
  computed directly from the tarball's bytes — a version-string match alone
  says nothing about contents, and computing it from the bytes keeps the check
  clear of the packing path this script avoids. (Verified equal to npm's own
  value for a fixture tarball.)
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
  before anything is uploaded or moved. The immutability probe was run against
  an unreachable host and against a server returning 500: both stop, neither
  is mistaken for an unpublished version. Shell/bash syntax checks on all three
  scripts; the build script parses and resolves under Bun.
- **The 0.1.0 build, run for real.** All eight targets compiled under Bun
  1.3.14 from commit `f1a9144` on a clean tree — including `bun-windows-arm64`,
  which is a genuine target and not an x64 alias. The npm tarball, both
  installers and `manifest.json` were produced in the same run.
- **Executed, not merely built:**
  - `darwin-arm64`, copied out of the release and run from a directory outside
    the source tree: `version`, `--help` (all ten commands listed), and a real
    device-flow `login` + `list` against the project's fake server — five HTTP
    requests reached it and the projects rendered from its response.
  - The npm tarball installed into an empty prefix from the `.tgz` itself:
    same three checks, same results.
  - `install.sh` served over local HTTP from this exact release: it resolved
    the `latest` channel, parsed the manifest, verified the sha256, installed,
    and wrote its receipt. The installed binary runs with `node` absent from
    `PATH` and links only macOS system libraries.
  - `linux-arm64` under `debian:stable-slim` (no node, no python3 in the
    image): `version` and `--help` both fine.
- **What that build exposed.** `linux-arm64-musl` does *not* start on a bare
  `alpine:3.20` — `scanelf` shows it needs `libstdc++.so.6` and
  `libgcc_s.so.1`, which Bun's musl target links dynamically and Alpine does
  not ship. `apk add --no-cache libstdc++` fixes it; the binary then runs. This
  is a property of `bun build --compile --target=bun-linux-*-musl`, not of this
  source. `install.sh` now execs the verified binary before installing it and
  reports this case with the `apk` line, installing nothing; the README says so
  too.
- **Still unproven by execution:** the x64 builds of every platform, both
  Windows builds, and `linux-*-musl` on a *real* Alpine host rather than a
  container — this machine is arm64, so the x64 artifacts were compiled but
  never run. Windows ARM64 most of all, since nothing here can run it.
  `install.ps1` has still not been parsed or run: no PowerShell on this
  machine.

Treat a first release as needing one real run per platform before `stable`
moves. `--no-pointer` publishes a version that only a pinned `--version` install
can reach, which is the way to do that.

## Prerequisites still open

- **Bucket: done.** `dash-downloads` was created in the same account
  (`wrangler r2 bucket create`), public access enabled
  (`wrangler r2 bucket dev-url enable`), and the URL confirmed live: a GET of
  `https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev/ml-dash-cli/releases/latest`
  returns 404, which is the correct answer for an empty bucket and the signal
  the publish script reads as "not published yet". Nothing has been uploaded.
  Existing buckets (`dreamlake-downloads`, `lakeshore-releases`) were left
  alone. (One `r2 bucket list` failed with `fetch failed` and a retry
  succeeded — a single connectivity error is worth one retry, but an upload's
  exit code is still never proof, which is what the read-back gate is for.)
- **`dl.dash.ml` is deliberately not used** (see above). Moving the zone or
  adding a CNAME at NS1 is a separate decision; nothing here depends on it.
- **License: resolved.** `LICENSE` is the MIT text copied verbatim from the
  upstream Python `ml-dash` repository (`Copyright (c) 2025 Ge Yang, Tom Tao`),
  whose `pyproject.toml` declares the same MIT terms for the same project name.
  Nothing was invented and `package.json`'s `"license": "MIT"` already matched,
  so it was left untouched.
- **npm:** the name `ml-dash` is unregistered on the registry, so the first
  publish claims it. A local login exists on one machine and is deliberately
  not wired into CI. Publishing has not been attempted from anywhere.
- **`CLOUDFLARE_API_TOKEN` and `NPM_TOKEN` are not set on the repository**, so
  no release has been published by CI either. `CLOUDFLARE_ACCOUNT_ID` is set.
  Until both are added the workflow stops at its credential check — after the
  tests and the build, before a single byte is uploaded — so a missing secret
  costs a red run, never a half-published version. `-f dry_run=true` exercises
  the same path deliberately.
