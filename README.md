# ml-dash

ML experiment tracking from the command line. Authenticate, inspect projects
and experiments, and move experiment data to and from an ML-Dash server.

## Install

**macOS / Linux** — one self-contained binary, no Node or Python needed:

```sh
curl -fsSL https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev/install.sh | sh
```

**Windows** (PowerShell):

```powershell
irm https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev/install.ps1 | iex
```

**With Node ≥ 20.19 already installed:**

```sh
npm install -g @dreamlake/ml-dash
```

The command is still `ml-dash`. The package is scoped because the unscoped
name is not claimable — npm refuses `ml-dash` as too similar to the existing
`mldash`.

*Current state:* **0.1.1 is published and is what the commands above
install.** It is on npm as
[`@dreamlake/ml-dash@0.1.1`](https://www.npmjs.com/package/@dreamlake/ml-dash/v/0.1.1),
published from CI by npm trusted publishing (OIDC, no token) and carrying a
provenance attestation; on R2 all eight platform binaries, the tarball, the
manifest and both installers are published and were read back byte-for-byte;
and `latest` now reads `0.1.1`, so no `--version` is needed. `stable` is
deliberately still unwritten. The **GitHub Release
[`v0.1.1`](https://github.com/fortyfive-labs/ml-dash-cli/releases/tag/v0.1.1)**
carries all twelve artifacts — eight binaries, the tarball, both installers
and the manifest — each byte-identical to what R2 serves, tagged at the commit
they were built from. Both channels were installed from their public URLs and
run on 0.1.1.

Both channels run the same code — the binaries are `src/index.ts` compiled
ahead of time, the npm package is the same source compiled to `dist/`.

### Pinning a version

```sh
curl -fsSL https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev/install.sh | sh -s -- --version 0.1.1
```

```powershell
& ([scriptblock]::Create((irm https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev/install.ps1))) -Version 0.1.1
```

An installer always downloads from the host it was itself served from — that
base URL is compiled into it at build time — so piping one host's installer
into a shell never fetches binaries from somewhere else. `--base-url` /
`-BaseUrl` overrides it for testing against a staging bucket.

The installers verify every download against the sha256 in that release's
manifest before writing anything, so a pinned version installs identical bytes
on every machine. They install into `~/.local/bin` (`%LOCALAPPDATA%\ml-dash\bin`
on Windows) — override with `--install-dir` / `-InstallDir` — and they never
remove or overwrite an `ml-dash` installed by npm or pip; a conflict on PATH is
reported and left for you to resolve with the tool that owns it. If the
install path is already occupied by a file this installer did not write — a
symlink, a pipx shim, anything without its receipt — it stops instead of
overwriting; `--force` / `-Force` takes over deliberately.

## Updating

```sh
ml-dash update           # update to the latest release
ml-dash update --check   # report whether one exists; change nothing
```

`update` uses the channel this copy was installed from, and works it out from
the running process rather than guessing: an npm install runs
`npm install -g @dreamlake/ml-dash@<version>`, a standalone binary replaces
itself. Run from a source checkout it refuses outright, so `npm run cli --
update` in this repository cannot quietly rewrite the `ml-dash` on your PATH.

For a standalone binary, an update is only written after it has been proven:

- the version comes from the `latest` pointer in the same bucket the binary was
  installed from — the URL is compiled in, not configurable by a user;
- the download is checked against the sha256 **and** the byte count in that
  release's `manifest.json`, and is cut off the moment it runs past the
  declared length;
- the downloaded binary is run once (`ml-dash version`) and has to report the
  version that was asked for — the same gate `install.sh` applies, which is
  what catches a correct build for the wrong libc;
- only then is it renamed over the running binary, keeping its permissions, and
  the install receipt is refreshed so `install.sh` still recognises the install.

Any failure leaves the working binary exactly as it was and removes the
download. `update` never downgrades: if the pointer moves backwards it stops
and tells you to use `install.sh --version` if that is really what you want.

It will refuse, rather than force, an install it does not own. A binary sitting
in a Homebrew cellar, a Nix store, a pipx venv or a `node_modules` tree is left
alone with a pointer to that tool's own upgrade command, and so is a directory
it cannot write to.

`--version <x.y.z>` installs an exact release. `--json` prints the report for
scripts. On Windows the running `.exe` cannot be replaced while it is open, so
the verified file is swapped in as the command exits; `ml-dash update` tells
you that and your next `ml-dash` is the new one.

## Usage

```sh
ml-dash --help
ml-dash login
ml-dash list projects
ml-dash upload  <local-path> <remote-path>
ml-dash download <remote-path> <local-path>
```

Run `ml-dash <command> --help` for the flags of any command.

## Supported platforms

macOS (arm64, x64), Linux (x64, arm64; glibc and musl), Windows (x64, arm64).

The binaries bundle their own runtime, so no Node and no Python is needed.
They are not statically linked, though: the musl builds link against
`libstdc++.so.6` and `libgcc_s.so.1`, which a bare Alpine image does not
ship. On Alpine, install them once:

```sh
apk add --no-cache libstdc++
```

`install.sh` runs the downloaded binary before installing it, so a missing
system library is reported at install time with nothing written, rather
than at your next `ml-dash` command.

## License

MIT — see [LICENSE](LICENSE). Same terms and copyright as the Python `ml-dash`
package this CLI talks to.

## Releasing

See [docs/RELEASE.md](docs/RELEASE.md).
