# Stage 2 — `upload` and `download`

The two data-moving commands (1497 + 941 lines of Python) are implemented, and
the npm build now carries all ten commands. Nothing is published, and the
standalone-binary channel is still stage 3.

## What the commands claim

| Claim | Where it is reached |
| --- | --- |
| `upload` sends parameters, logs, metrics and files for every experiment under a `.dash` root | `src/commands/upload.ts` |
| Both metric layouts upload — `metrics/<name>/data.jsonl` and flat `metrics/<name>.jsonl` | `LocalStorage.listMetrics` |
| `-p` filters by fnmatch glob, `ns/project` path prefix, or bare project name | `matchesFilter` |
| `--dry-run` sends nothing; `--skip-{logs,metrics,files,params}` drop one section each | `run` / `uploadExperiment` |
| `--resume` + `--state-file` skip experiments a previous run completed | `loadState` / `saveState` |
| Unparseable log and metric lines are skipped and counted, never sent as `undefined` | `uploadLogs`, `LocalStorage.readMetricPoints` |
| Metric uploads run five at a time, chunk downloads ten, file downloads `--max-concurrent-files` | `src/util/pool.ts` |
| `download` writes experiment.json, parameters.json, logs.jsonl, metric points and files into the prefix tree | `src/commands/download.ts` |
| A file whose SHA-256 does not match the server's is deleted, not stored, and the run exits non-zero | `downloadSingleFile` |
| Local file IDs stay string Snowflakes | `LocalStorage.generateSnowflakeId`, asserted in `transfer.test.ts` |
| `upload --tracks` / `download --tracks` move one track file | `uploadTrack`, `downloadTrack` |
| Every flag and alias from the Python `add_parser` is accepted, plus the positional `PATH` | `spec` in both commands |

Exit codes: 0 when every experiment succeeded, 1 on any failure or usage
error, 2 for an unparseable command line.

## Divergences from the Python CLI, and why

Each of these is a case where the Python command reported success while moving
no data. They are deliberate, not accidental.

1. **Python's upload discovery only saw `metrics/<name>/data.jsonl`.** An
   experiment recorded through `write_metric_data` (the flat layout) uploaded
   as a success with none of its metrics. Discovery here reads both layouts.
2. **Python located files through the *declared* `prefix`, and skipped file
   upload entirely when that prefix had fewer than three segments.** Files are
   now read from where they actually are; the declared prefix is still what
   the server is told.
3. **Python treated a failed section as a success.** `result.failed` was
   populated and `success = True` set anyway, so a run that lost every metric
   exited 0 and deleted its own resume state. Any failed section now fails the
   experiment, which keeps the state file and exits 1.
4. **Python's downloader could not write anything.** Every `self.local.*` call
   passed `project=`/`experiment=` to a `LocalStorage` whose signature is
   `(owner, project, prefix, …)`; each raised `TypeError`, each was swallowed,
   and the experiment was still marked successful. A download produced an
   `experiment.json` and nothing else.
5. **Python read file fields that the server does not send.** The GraphQL page
   returns `name`/`pPath`/`physicalFile{…}`; Python indexed `["filename"]`,
   `["path"]`, `["checksum"]`. Normalised in `normalizeFile`.
6. **Python never verified a downloaded checksum**, despite `download_file_streaming`'s
   docstring. Verification happens in a scratch directory; only a matching file
   is copied into the tree.
7. **`has_params` came from a field the list query never selects**, so a
   multi-experiment download skipped every parameter set. Parameters are now
   fetched unless `--skip-params`; metric names fall back to the REST metric
   list when GraphQL returns none.
8. **The "already exists locally" check looked at `root/project/experiment`**,
   which is not where the downloader writes. It now uses the prefix path.
9. **`remove` without `-y`** no longer refuses every non-tty invocation. Python
   read the confirmation with `console.input()`, so `echo my-project | ml-dash
   remove -p my-project` was a supported way to confirm; that works again.
   End-of-input cancels and exits 0 rather than hanging on the prompt.

One thing the Python client does that looks like a bug and is not: the `prefix`
is deliberately *not* sent on the node-create payload ("ignored in new API —
use folders instead"). Placement comes from the folder chain and `parentId`.

## Failures found while building this

- The root help and `npm pack` install initially looked like they had dropped
  `upload`/`download`; the command list was being cut by `head -16`. Nothing
  was wrong with the build.
- `npm test` ran `tsc --noEmit` and then executed `dist/`, so it could pass
  against a stale build. It now runs `npm run build` first.
- A test asserting `prefix` on the experiment-create payload failed, which is
  how the folder-placement behaviour above got covered by a real test instead
  of an assumption.
- Python's `read_file` returns a path, not bytes, and verifies the recorded
  checksum on the way — which makes it a stronger reader for the interop test
  than a raw file read.

## Evidence

`npm test` — 67 tests, 0 failures. It builds first, then drives the compiled
CLI as a subprocess against a real HTTP server on a real port.

- `test/transfer.test.ts` (19 tests) asserts on requests the server received
  and bytes that landed on disk, never on the command's own bookkeeping:
  parameters, three of five log lines (two junk lines skipped), both metric
  layouts, the uploaded file's bytes *and* that the checksum sent describes
  them; the folder chain for a nested prefix; `--dry-run` posting nothing;
  skip flags; an injected 500 on `/logs` producing exit 1 with the state file
  kept and `failed_experiments` recorded; `--resume` uploading only the
  experiment that was not already complete; a glob `-p` selecting one of two;
  download of chunked + buffered metric points in index order; a checksum
  mismatch exiting 1 with nothing left in the tree; skip-existing and
  `--overwrite`; `-t` retargeting the namespace and project; `--strict` turning
  a warning into a refusal; and a full upload→download round trip.
- `test/local-format.test.ts` (2 tests) runs both directions through Python's
  `ml_dash.storage.LocalStorage` in the ml-dash virtualenv: Python reads back
  the parameters, metric points and file (checksum-verified) that `download`
  wrote, and `upload` sends the contents of a tree Python wrote. The suite
  skips, rather than passes, when that interpreter is absent.
- `test/cli.test.ts` (43 tests, three new) covers the piped, mismatched and
  EOF confirmation paths for `remove`, and that both new commands appear in the
  root help with their positional `PATH`.

Manual check with the **installed npm tarball** (`npm pack` → `npm install
./ml-dash-0.1.0.tgz` in a scratch directory), driving
`node_modules/.bin/ml-dash` against a local server: login 0, upload 0 with the
server receiving `{"lr":0.01}`, `["up"]` and `{"loss":[{"step":0,"loss":7}]}`;
download 0 writing the parameters, metric point and file bytes to disk; and a
download of deliberately corrupted bytes exiting 1 with "checksum mismatch".
Scratch directories were removed afterwards.

## Not covered

- No mutation testing and no second assertion framework, by instruction.
- Concurrency limits are exercised but not stress-tested: no test drives 400
  metrics to prove the pool bounds socket count.
- `--tracks` on both commands is implemented against the same client methods
  the `list --tracks` path already uses, but has no subprocess test in this
  stage; the fake server has no track-data route.
- `upload --batch-size` and `download --max-concurrent-*` are implemented and
  validated, but only their defaults are exercised end to end.
- No cross-platform release build, no publishing, no Python removal, no docs
  site change, no remote or production writes.
