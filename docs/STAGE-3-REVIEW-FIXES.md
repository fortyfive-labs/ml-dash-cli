# Stage 3 — two pre-release gaps closed

Nothing is published. This stage fixed one product risk found in review and
gave `--tracks` the subprocess test it never had.

## A. A download could write outside the tree it was given

**The claim.** `download` writes only into the `.dash` tree the user named and
into its own scratch directory.

**Where it was reached.** The server decides three paths that the downloader
then joins onto a local root: an experiment's `metadata.prefix`, a file's
`pPath`, and its filename. All three went into `path.join` unchecked —
`src/commands/download.ts` (`downloadSingleFile`) and `src/local/storage.ts`
(`experimentDir`, the metric directory, `filePath`, `writeFile`).

**Direct evidence, before the fix.** Both cases run the compiled CLI as a
subprocess against a server that answers with a `..` in that metadata, with a
sentinel file one directory above the download root:

- A file whose `pPath` climbs five levels: the bytes landed *outside* the
  download root and the run exited **0** — "✓ Downloaded successfully".
- An experiment whose prefix climbs three levels: a directory was created
  outside the download root, again exiting 0.
- Reverting only `src/` in a scratch copy of the repo and re-running the two
  new tests fails them on exactly those observations
  (`the file was written outside the download root`, `the prefix created a
  directory outside the download root`), not on the exit code alone.

An earlier variant of the file case also showed the *scratch* write escaping —
the unverified bytes were opened at `/var/folders/sentinel.txt`, four levels
above the temp directory, and were stopped only by an EPERM from the OS.

**The fix.** `src/local/safe-path.ts` is the one place the rule lives:

- `safeSegment` for a single component (filename, file id), `resolveWithin`
  for a nesting one (prefix, metric name, file path).
- Rejected: `..` segments, absolute paths, Windows drive letters, backslash
  separators (a separator on one platform and a legal filename character on
  the other), NUL bytes, anything resolving outside the root, and any target
  reached through an existing symlink that leaves the root — checked with
  `realpath` on the deepest existing part of the path.
- Legal nesting still works: `owner/project/folder/exp`, `train/loss`,
  `checkpoints/…`.
- Reject, never repair. A refused path fails its section and the run exits 1;
  it is not rewritten into some other location, and no existing file of the
  user's is removed.
- The scratch download now uses a fixed local name (`payload`), so the
  server's filename decides only where the *verified* file lands.

**Result.** Both subprocess tests pass: exit 1, "unsafe …" on stderr, the
sentinel byte-identical, and nothing created beside the download root. A
direct check of the boundary rules against the compiled `LocalStorage`
refuses a prefix through a symlink to an outside directory, a `..` prefix, an
absolute prefix, a backslash prefix, a `C:` prefix and a `..` metric name,
while allowing a nested metric name and a nested prefix — with the outside
directory left holding only its sentinel.

## B. `--tracks` had no end-to-end test, and was broken

Stage 2 listed `--tracks` as implemented but untested. Testing it found a real
protocol defect: `appendBatchToTrack` posted to `…/tracks/{topic}/append-batch`
— the spelling the *metric* route uses. The track routes are `append_batch`
with an underscore, in `ml-dash-server/src/routes/tracks.ts` and in the Python
client (`client.py:2077`). Every track upload would have 404'd against a real
server.

The fake server grew the two track routes it was missing, modelled on the real
ones: `POST …/tracks/:topic/append_batch` (one percent-encoded topic segment,
`entries` non-empty, every entry carrying a timestamp) and
`GET …/tracks/:topic/data` (`jsonl` as ndjson bytes, `json` as an object). It
also now echoes an experiment's `metadata` on the single-experiment query
instead of hardcoding `null`, which is what a real server returns.

**Result.** One CLI upload → download round trip: the JSONL file uploads, the
recorded request is `POST /api/experiments/…/tracks/robot%2Fjoints/append_batch`
with the two entries intact, and `download --tracks --format jsonl` writes back
bytes identical to the source file. Against the pre-fix client the same test
fails with `HTTP 404 … /append-batch`.

## Evidence

`npm test` — **70 tests, 0 failures** (67 before; +2 boundary, +1 track round
trip). It builds first and drives the compiled CLI as a subprocess. The Python
interop tests still pass, so the boundary checks did not reject the trees the
Python SDK writes.

Scratch copies used for the before/after comparison were removed.

## Not covered

No mutation testing, no per-variant test stacking — the remaining shared
structural constraints were source-checked: every other `path.join` in
`storage.ts` and `download.ts` uses a literal name, a locally generated file
id, a directory entry read from the local tree, or an already-validated
directory.

Still ahead of a release: the R2 standalone-binary install script, removing the
Python package, the docs site, and the actual npm/R2 publish. None of it is
started.
