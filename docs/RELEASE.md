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
2. Eight binaries, `dreamlake-ml-dash-<version>.tgz`, both installers and `manifest.json`
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

### The npm package is `@dreamlake/ml-dash`

The unscoped name is not available. A publish was attempted from a laptop and
the registry refused it:

```
E403  Package name too similar to existing package mldash
```

`mldash@0.0.1` exists, and npm rejects a new unscoped name that differs from an
existing one only by punctuation. A 404 on `npm view ml-dash` means the name is
*unused*, which is not the same as *available*.

Scoped names are exempt from that rule, and `@dreamlake` is an existing org
(owner `episodeyang`) that the publishing account is a member of, so
**`@dreamlake/ml-dash`** is the name. `@fortyfive-labs` was the other candidate
and would have needed the org created first — `registry.npmjs.org/-/org/
fortyfive-labs` is 404.

What this changes and what it does not:

- The command is still `ml-dash` — `bin` is unchanged, and so are the compiled
  binary filenames, the R2 prefix `ml-dash-cli/releases/` and the installer
  URLs. Nothing about the R2 channel moves.
- `npm pack` flattens the scope, so the tarball is `dreamlake-ml-dash-0.1.0.tgz`
  rather than `ml-dash-0.1.0.tgz`. `build-release.ts` finds it by extension and
  records whatever npm wrote, so the manifest, the R2 object key and the
  Release asset all follow automatically.
- Nothing hard-codes the name. `publish-release.sh` reads it from
  `package.json`, checks it against the manifest, and percent-encodes it for
  the registry query (verified: `@dreamlake/dreamlake-cli` resolves, so the
  encoding is right rather than uniformly 404). The workflow derives Release
  asset names and install instructions from the manifest.
- The similarity precheck is skipped for scoped names, because npm's rule does
  not apply to them.

One consequence worth knowing: `release/0.1.0/` on a developer machine was
built under the old name, so its manifest says `ml-dash` and
`publish-release.sh` now refuses it — `manifest was built for package 'ml-dash'
but package.json says '@dreamlake/ml-dash'`. That is the guard working. CI
rebuilds from source on every run, so nothing needs rescuing.

### Secrets the workflow needs

| Name | Where it comes from | Used for |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | the account owning `dash-downloads` | wrangler target account — **set** |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens, a **custom token** scoped to that account with `Workers R2 Storage: Edit` and nothing else | uploading and pointer moves — **not set** |
| `NPM_TOKEN` | npmjs.com → Access Tokens → **Granular access token**, read+write on the package named in `package.json` (once that name is publishable), no org scope | the first publish only — **not set** |

The npm token is genuinely required for the first publish and genuinely
avoidable after it. npm trusted publishing (OIDC) can only be configured on a
package that already exists — the registry's settings page is the only place to
enable it — so a new name has to be claimed once with a token
([npm/cli#8544](https://github.com/npm/cli/issues/8544)). The workflow is
written for both: with `NPM_TOKEN` present it publishes with `--provenance`;
with it absent it performs the OIDC handshake and publishes nothing else
differently. So once the first version is out, configure the trusted publisher on
npmjs.com (org `fortyfive-labs`, repo `ml-dash-cli`, workflow `release.yml`),
**delete the `NPM_TOKEN` secret and revoke the token**, and later releases need
no npm credential at all. Skipping that last step is the whole point of the
exercise thrown away.

A local `npm login` is deliberately not a dependency of any of this.

### What CI has actually proven so far

Three `dry_run=true` runs on `ubuntu-latest`, the most recent
([35815006139](https://github.com/fortyfive-labs/ml-dash-cli/actions/runs/35815006139),
commit `4e239bc`) being the one that matters now: 71 tests passed, all eight
targets plus the tarball, installers and manifest built in a single run, and
the manifest check passed. The publish steps were skipped, as a dry run
intends — **nothing has been published to npm, R2 or Releases by CI or by
anyone else.**

That run is also the evidence that the scoped rename works end to end and not
just locally. Its manifest records `name: @dreamlake/ml-dash` and `tarball:
dreamlake-ml-dash-0.1.0.tgz`, and the packed tarball's own `package.json`
carries the scoped name, `version 0.1.0`, `bin: {"ml-dash": …}` and
`publishConfig.access: public` — so the command stays `ml-dash` and the
package publishes publicly under the scope.

Worth recording, because it was not assumed: the eight binaries CI produced on
`ubuntu-latest` are **byte-identical** to the ones built on a macOS arm64
laptop. The two commits differ (`9d5ee25` vs `7637326`), but only in
`docs/RELEASE.md`, `scripts/publish-release.sh` and `.github/` — **no file
under `src/` changed**, so this is a cross-host result for one CLI source tree
and nothing more. It does not show that source changes leave the output alone,
and it is not a general reproducibility claim: it says the R2 binaries do not
depend on which of these two machines builds them.

The npm tarball differs in size between hosts, and the reason is mundane. A
second dry run
([35813991008](https://github.com/fortyfive-labs/ml-dash-cli/actions/runs/35813991008))
now keeps the `.tgz` with the run, so it could be opened rather than guessed
at: unpacked, **every packed file is byte-identical except `README.md`**, which
genuinely changed in that commit. `package.json` is identical across the two
commits — `npm pack` adds no `gitHead` here — and the packed file list is the
same. `npm pack` was also run twice on one tree and produced byte-identical
output. So the packed *content* is host-independent and `npm pack` is not
non-deterministic; the size moved because a packed file moved.

The earlier 99-byte delta (run `35813302906`, where `README.md` had *not*
changed) cannot be attributed with the same confidence — that run did not
retain its tarball, and it no longer exists. Given the above, gzip output
differing between Node 26/macOS and Node 24/linux is the remaining
explanation, but that is inference, not something checked.

### Nothing is uploaded until npm is known to be publishable

R2 is written before npm, because a channel pointer must not move to binaries
nobody can fetch. The cost of that order is that an npm failure would land
*after* the bucket is written — a half-published release. So the run settles
npm first, with `publish-release.sh <version> --precheck-npm`, which uploads,
publishes and moves nothing:

| Registry state | Result |
| --- | --- |
| version published, same bytes | proceed — the npm step will verify and skip |
| version published, different bytes | **stop** (versions are immutable) |
| package exists, version is new, `NPM_TOKEN` set | proceed |
| package exists, version is new, no token | **stop** unless `ML_DASH_NPM_TRUSTED=1` |
| package does not exist, no token | **stop**, no override |
| new unscoped name whose punctuation-stripped form is taken | **stop** — npm would answer E403 |
| registry unreachable / any non-404 error | **stop** |

The registry is read over plain HTTP rather than through `npm view`, for the
same reason the R2 probe is: `npm view` exits non-zero for "no such package"
and for "the registry is down" alike, and treating the second as the first is
how a first publish gets attempted blind.

Two limits worth stating plainly. **Whether a trusted publisher is configured
is not readable** — the registry exposes no such field — so the no-token case
stops by default and `ML_DASH_NPM_TRUSTED=1` is a human asserting they have
read the package's settings page, not a verified fact. And **the similarity
check is an approximation**: npm's rule runs server-side with no API, so this
only catches the exact-collision case (strip `-`, `_`, `.` and look the result
up), which is the case that actually bit here. A subtler collision would still
surface as an E403 from npm.

For `0.1.0` as it stands, this gate stops the run before any upload: the
package does not exist yet, which makes it a first publish, and no `NPM_TOKEN`
is set. The name is no longer a problem — `@dreamlake/ml-dash` is scoped and
unused.

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
release/<version>/<pkg>-<version>.tgz        npm package, packed at build time
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

## `ml-dash update`, and what a release owes it

From 0.1.1 the CLI updates itself, which makes two things the release process
has to keep true.

**A binary must look for its own updates where it ships.** `src/update/release.ts`
holds the bucket URL as a constant compiled into every binary — deliberately
not read from the receipt, the config file or a user's environment, because an
update that can be redirected is an update that can be substituted.
`scripts/build-release.ts` therefore refuses to build when that constant does
not equal the `--public-url` the release is being published to, the same way it
already refuses when `src/version.ts` disagrees with `package.json`. Changing
the serving host now means changing one more line, and the build says so rather
than shipping binaries that look for updates at an address the release does not
occupy.

**The `latest` pointer is the update channel.** `--no-pointer` publishes a
version reachable only by a pinned install — that is still the right way to
land a platform matrix nobody has run — but until `latest` moves, no installed
binary will offer the update. `stable` is not read by `update` at all.

`ML_DASH_UPDATE_BASE_URL` and `ML_DASH_UPDATE_REGISTRY` mirror the `--base-url`
override the installers have always had, for testing against a staging bucket.
They are narrow: HTTPS only, except for a loopback address, and an override is
announced on stderr so a redirected update is never silent.

### What has been exercised, and what has not

Verified by execution on this macOS arm64 host (`test/update.test.ts`, 35 tests
in the suite, part of `npm test`):

- **A real compiled binary updating itself.** Two `bun build --compile` binaries
  of this working tree, differing only in `src/version.ts`, and a local HTTP
  server serving a build-shaped `latest` pointer, `manifest.json` and binary.
  The 0.1.0 binary updates itself to 0.1.1, and the *installed file* is then run
  and reports the new version — the claim is checked by execution, not by the
  command's own output. Its 0700 mode is preserved, the install receipt is
  rewritten in `install.sh`'s format, the install directory is left holding
  exactly the binary and the receipt, and a second run reports "already latest".
- **Failures leave the working binary alone.** A download with the right length
  and wrong bytes (checksum mismatch), a body 4 KB longer than the manifest
  declares, a release with no build for this platform, and an unreachable
  source: each exits 1, and each is followed by running the still-installed
  binary to confirm it is the old version, with no temporary file left behind.
- **Refusals.** A source checkout (so `npm run cli -- update` cannot rewrite the
  `ml-dash` on `PATH`), a symlinked install path, an install path inside another
  package manager's store, an unwritable install directory, a pointer that moves
  backwards, a non-semver `--version`, and a non-loopback `http://` override —
  the last one refused by the compiled binary itself, not only by the library.
- **An oversized metadata body** is cut off mid-stream, proven against a server
  that answers a 1 KB-capped read with an endless one.

One thing measuring this changed. The obvious guard against updating another
tool's install — refuse when the target is a symlink — turns out not to fire:
`process.execPath` is symlink-resolved by the OS, confirmed on this host by
running a compiled binary through a symlink and watching it report the link's
target. So a `~/.local/bin/ml-dash` pointing into a Homebrew cellar would have
handed `update` the cellar's real file, and the lstat check would have seen an
ordinary file and allowed it. The path-based store check above is what actually
closes that, and the symlink check is kept as the secondary guard it really is.
- **The npm channel, through a real `node_modules` tree.** The package copied
  into `node_modules/@dreamlake/ml-dash` with its dependencies beside it is
  detected as the npm channel — the same `package.json` in a checkout is not —
  and `--check` against a fixture registry reports the newer version without
  invoking npm at all. `findNpm()` is proven by spawning what it returns and
  reading a version out of it, with `shell: false`.

Not exercised, and not claimed:

- **The Windows post-exit swap.** No Windows and no PowerShell on this host, so
  what is tested is the contract of the script that gets written — it waits on
  this exact PID, moves the staged file onto the target, refreshes the receipt
  in `install.ps1`'s format, removes the download if the move throws, and
  deletes itself last — plus the quoting, which is asserted by parsing the
  literals back out and requiring them to equal the paths that went in. Whether
  PowerShell then does the right thing is unproven here, exactly as
  `install.ps1` and the `windows-arm64` build are.
- **`npm install -g` actually running.** The tests stop at `--check` and at the
  argument vector; a test that installed a global package would mutate the
  machine running it. What is checked is that the version is a single strict-
  semver-validated argv entry, that npm is reached without a shell, and that the
  command re-reads what npm left installed and fails when it is not the version
  that was asked for.
- **A downloaded binary of a *different* platform.** The smoke test that catches
  a musl/glibc mismatch runs the staged binary before installing it, and that
  path is exercised — but only with a binary this host can run.

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
    the source tree: `version`, `--help` (all ten commands of that release listed), and a real
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
  returned 404, which is the correct answer for an empty bucket and the signal
  the publish script reads as "not published yet". The bucket is no longer
  empty — 0.1.0's artifacts and the installers are in it — but that key is
  still 404, because no run has moved a pointer.
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
- **npm: `0.1.0` is published; CI still cannot publish.** `@dreamlake/ml-dash`
  (the unscoped name was refused — see above) was published to the registry by
  hand from a machine holding an npm login, because trusted publishing cannot
  be configured for a package that does not exist yet. That first publish is
  what unblocks it: the package now has a settings page, so a **GitHub trusted
  publisher can and should be configured** — owner `fortyfive-labs`, repository
  `ml-dash-cli`, workflow `release.yml` — after which `NPM_TOKEN` should be
  deleted rather than left in the repository. Until that is done, CI has no way
  to publish to npm and `0.1.1` cannot be released.
- **R2: `0.1.0` is published but no pointer names it.** The versioned objects
  under `ml-dash-cli/releases/0.1.0/` and both installers are live and readable;
  `ml-dash-cli/releases/latest` and `stable` are still 404. So
  `curl … install.sh | sh` fails at channel resolution today, and
  `ml-dash update` on a standalone install has nothing to read. Both need
  `--version 0.1.0` until a release run moves `latest`.
- **`CLOUDFLARE_API_TOKEN` and `NPM_TOKEN` are not set on the repository**, so
  no release has been published by CI either. `CLOUDFLARE_ACCOUNT_ID` is set.
  Until both are added the workflow stops at its credential check — after the
  tests and the build, before a single byte is uploaded — so a missing secret
  costs a red run, never a half-published version. `-f dry_run=true` exercises
  the same path deliberately.
