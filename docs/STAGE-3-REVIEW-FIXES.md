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

**A second gap, found reviewing the first fix.** The initial version anchored
its checks at derived directories — `…/metrics` for a metric name, `…/files`
for a file path — and resolved only the deepest *existing* ancestor with
`realpath`. Both are the same hole: if `files` or `metrics` is itself a link
out of the tree, the "root" of the check is already outside it and every
lexically-clean path is accepted; a dangling link fails `realpath` and reads
as "not there yet"; a link at the leaf (`parameters.json`, `data.jsonl`,
`.files_metadata.json`) is never looked at, and `writeFile` skipped resolution
altogether when a file had no `path`.

**The fix.** `src/local/safe-path.ts` is the one place the rule lives, and
`LocalStorage` is the only thing that builds paths:

- One root: `LocalStorage.rootPath`, canonicalised once (the user chose that
  path deliberately, so its own links are what they asked for). No derived
  directory is ever treated as a new root — `resolveUnderRoot(root, parts)`
  takes the whole chain, server-supplied and literal parts alike, and builds
  it from the root down in a single pass.
- Every component of a write target is walked with `lstat`, which sees a
  symlink whether or not it points at anything, and a link anywhere in the
  chain is refused with that reason named. Reads keep the lexical rules only,
  so `upload` still works on a tree where the user symlinked their own data.
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

**Result.** Three subprocess tests pass. The two metadata ones exit 1 with
"unsafe …", the sentinel byte-identical and nothing created beside the
download root. The third plants the tree instead of the metadata: the
experiment's `files` directory is a pre-existing symlink to a directory
outside the root, the server's own metadata is ordinary, and the download
exits 1 naming the symbolic link, writes nothing through it, leaves the
sentinel and the outside directory untouched, and leaves the user's link in
place rather than replacing or deleting it.

A direct check against the compiled `LocalStorage` covers the shared
structure the tests do not each repeat: a metric write through a linked
`metrics` directory, a parameters write onto a *dangling* link, and a file
write whose `.files_metadata.json` is a link are all refused; a nested metric
name and a nested file path in a clean experiment are still allowed; the
outside directory keeps only its sentinel and both links survive. The earlier
lexical rules are unchanged — `..`, absolute paths, `C:`, backslash
separators and NUL bytes are refused wherever they appear.

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
structural constraints were source-checked. `storage.ts` has no `path.join`
left on any write, replace or delete target: each of them is a
`this.target([…])` call rooted at `rootPath`. The two remaining joins are in
`listMetrics`, which composes names it just read from the local directory for
`upload` to read back, and the scratch path in `download.ts`, which is a
`mkdtemp` directory plus the fixed name `payload`.

Still ahead of a release: the R2 standalone-binary install script, removing the
Python package, the docs site, and the actual npm/R2 publish. None of it is
started.
