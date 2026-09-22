# Stage 1 — core commands on the npm channel

Scope of this stage: the npm (plain JavaScript) entry point builds and runs,
and eight commands are fully implemented and covered by behaviour tests that
drive the real CLI as a subprocess against a real HTTP server.

`upload` and `download` are **not** in this build. They are rejected by name
with exit code 2 and a message saying so, rather than accepted as no-ops — a
backup script must not be able to "succeed" while moving no data.

## What was added

| Path | Role |
| --- | --- |
| `src/index.ts` | Entry point; lazy per-command imports, exit codes 0/1/2 |
| `src/cli/parser.ts` | argparse-shaped option parser (aliases, `=`-values, choices, mutually-exclusive groups) |
| `src/cli/context.ts` | Server URL + credential resolution shared by all commands |
| `src/commands/{version,login,logout,profile,api,create,remove,list}.ts` | The eight commands |
| `test/fake-server.ts` | ml-dash + vuer-auth stand-in; records every request |
| `test/cli.test.ts` | 41 subprocess behaviour tests |
| `test/fernet-interop.test.ts` | 3 tests against Python's `cryptography` |

The flag surface is taken from the Python `add_parser` functions in
`ml-dash/src/ml_dash/cli_commands/`, including every alias
(`--dash-url`/`--api-url`, `-p`/`--pref`/`--prefix`/`--proj`/`--project`).
`commander` was dropped as a dependency because it keeps only one short and
one long spelling per option, which would have silently discarded the others.

## Bugs found and fixed while testing

1. **Fernet key file read as raw bytes.** `TokenStore` passed the *file
   contents* of `encryption.key` to `parseKey`, but Python writes base64 text
   there. Every fallback-file login failed with "key must decode to 32 bytes".
   Found by the login test, not by inspection.
2. **Unpadded base64 in Fernet output.** `generateKey()` and `encrypt()`
   emitted Node's `base64url`, which strips `=`. Python's
   `base64.urlsafe_b64decode` rejects that, so tokens this CLI wrote were
   unreadable by the Python CLI sharing `~/.dash` — while round-tripping
   perfectly against themselves. Found only by the Python interop test.
3. **Three block comments contained `*/` inside example paths**
   (`'tom/*/exp*'`, `metrics/*/data.jsonl`), terminating the comment early and
   breaking compilation of `src/util/glob.ts`, `src/local/storage.ts`.
4. **`BodyInit` is not a global in `@types/node`** — `src/client.ts` did not
   typecheck.

## Deliberate divergences from the Python CLI

- `profile --json` emits plain text status strings; the Python version embedded
  `rich` markup (`[red]Token expired[/red]`) inside JSON meant for scripts.
- `list` pages interactively only when stdin *and* stdout are terminals. The
  Python version put the tty into raw mode unconditionally, so `ml-dash list |
  head` died inside its own pager.
- `remove` without `-y` and without a terminal exits 1 instead of reading a
  confirmation from a pipe.

## Verification

Command: `npm test` (`tsc --noEmit` then `node --test`). Result: **44 tests,
44 pass, 0 fail** (`npm run build` clean; `npm pack` → 25 files, 34.4 kB).

Each test runs the shipped entry point `bin/ml-dash.js` → `dist/` as a
subprocess, with `ML_DASH_CONFIG_DIR` pointing at a per-test temp directory and
`ML_DASH_NO_KEYCHAIN=1`, against a per-test HTTP server on a loopback port.
Nothing inside the CLI is stubbed, patched or called directly.

Claims, and what would have to break for each test to be worth anything:

| Product claim | Reachable behaviour exercised | Observable failure it would catch | Minimum evidence |
| --- | --- | --- | --- |
| The npm package installs and runs | `npm pack` → install the tarball into an empty project → `node_modules/.bin/ml-dash version` / `profile --json` | A broken `bin` shim, a missing `dist` in `files`, an unresolvable import | Exit 0 and correct stdout from the installed binary, not from the source tree |
| `login` completes the real device protocol | Full flow against the fake auth server | Wrong endpoint, wrong body, a hash computed differently from the Python CLI | Server-recorded `client_id`, 64-hex `device_secret_hash`, the *same* hash on poll, `Bearer` on `/api/auth/exchange` |
| Credentials are never leaked | Same test | Token printed on success, or written in clear | Assertions that stdout+stderr do not contain the token, and that `tokens.encrypted` does not either |
| Stored credentials interoperate with the Python CLI | `encrypt`/`decrypt` against `cryptography.fernet` in the ml-dash virtualenv, both directions | A self-consistent but non-Fernet implementation (exactly what was shipped before this stage) | Python decrypts our token *and* we decrypt Python's; test **skips**, never passes, when that interpreter is absent |
| 19-digit IDs survive end to end | Server returns Snowflakes as bare JSON numbers | `JSON.parse` rounding an ID to `…4444444444444000` | Printed `ID: 4444444444444444444` and `user.sub` `9876543210987654321` compared digit-for-digit |
| Commands actually talk to the server | Request log assertions on `create`/`remove`/`list` | A command that prints a success banner and sends nothing | Recorded path/method/body: `POST /api/namespaces/test-user/nodes` `{type:"PROJECT"}`, `DELETE /api/projects/1111111111111111111` |
| Refusals are real refusals | Unauthenticated `create`/`list`, `remove` without `-y`, `-p a/b/c` | A "refusal" that still performed the request | `server.requests.length === 0`, and the project still present in server state |
| Every documented flag alias works | `list` run once per alias | A porting shortcut that kept only `-p`/`--project` | Identical output for `-p`, `--project`, `--proj`, `--prefix`, `--pref` |
| Glob patterns reach the server correctly expanded | `-p 'exp*'`, `-p 'someone/proj*'` | Sending `exp*` unexpanded, which matches nothing server-side | Recorded GraphQL variable `pattern` equals `test-user/exp*/*` and `someone/proj*/*` |

No mutation testing, and no test of the test harness: the fake server is
asserted on only through the CLI's own observable behaviour.

## Not done in this stage

- `upload` / `download` (the two largest Python modules, 1497 + 941 lines).
  `src/local/storage.ts` and the client's file/metric/track methods are already
  in place for them.
- `scripts/build-release.ts` (the `bun build --compile` R2 binary) does not
  exist yet, so `npm run build:release` fails. Stage 2.
- Removing the Python CLI, documentation, and any publishing.
