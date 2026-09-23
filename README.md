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

*Not published yet:* the npm channel is built and tested on every release run,
but no version has reached the registry. Until one does, use the installers
above. `docs/RELEASE.md` tracks what is outstanding.

Both channels run the same code — the binaries are `src/index.ts` compiled
ahead of time, the npm package is the same source compiled to `dist/`.

### Pinning a version

```sh
curl -fsSL https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev/install.sh | sh -s -- --version 0.1.0
```

```powershell
& ([scriptblock]::Create((irm https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev/install.ps1))) -Version 0.1.0
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
