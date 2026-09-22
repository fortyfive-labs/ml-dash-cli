# ml-dash

ML experiment tracking from the command line. Authenticate, inspect projects
and experiments, and move experiment data to and from an ML-Dash server.

## Install

**macOS / Linux** — one self-contained binary, no Node or Python needed:

```sh
curl -fsSL https://dl.dash.ml/install.sh | sh
```

**Windows** (PowerShell):

```powershell
irm https://dl.dash.ml/install.ps1 | iex
```

**With Node ≥ 20.19 already installed:**

```sh
npm install -g ml-dash
```

Both channels run the same code — the binaries are `src/index.ts` compiled
ahead of time, the npm package is the same source compiled to `dist/`.

### Pinning a version

```sh
curl -fsSL https://dl.dash.ml/install.sh | sh -s -- --version 0.1.0
```

```powershell
& ([scriptblock]::Create((irm https://dl.dash.ml/install.ps1))) -Version 0.1.0
```

The installers verify every download against the sha256 in that release's
manifest before writing anything, so a pinned version installs identical bytes
on every machine. They install into `~/.local/bin` (`%LOCALAPPDATA%\ml-dash\bin`
on Windows) — override with `--install-dir` / `-InstallDir` — and they never
remove or overwrite an `ml-dash` installed by npm or pip; a conflict on PATH is
reported and left for you to resolve with the tool that owns it.

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

## Releasing

See [docs/RELEASE.md](docs/RELEASE.md).
