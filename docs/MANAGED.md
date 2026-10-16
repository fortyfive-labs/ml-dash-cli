# Managed Experiments CLI

This is an unreleased **0.2.0 candidate** in **`@dreamlake/ml-dash`**, invoked
as **`ml-dash`**. It is not a replacement for the Python logging SDK and is not a
claim of publication or production readiness. Matching DreamLake BFF and Dash
managed routes are required. Source-backed storage is excluded.

## Login, identity and discovery

Managed commands use the existing DreamLake `~/.dreamlake/config.json` and
`tokens.json` slots. They do not reuse or copy a standalone Dash token. An
explicit `auth login` runs the existing Vuer `dreamlake-app` device flow and
DreamLake `/auth/exchange`, validates `/auth/me`, and materializes the shared
DreamLake user login. It preserves other config settings. Scoped workload tokens
are acquired in memory for one operation, never written or printed. The top-level
`login` command continues to serve standalone Dash.

```sh
ml-dash auth status --json
ml-dash auth login --no-browser --json
ml-dash instance show --json
ml-dash orgs list --limit 50 --json
ml-dash orgs members --namespace fortyfive --json
ml-dash projects list --namespace fortyfive --limit 50 --json
ml-dash projects access --namespace fortyfive --project research-harness --json
```

`--dreamlake-url` selects the BFF, not an arbitrary Dash server. An existing
credential is sent only to its matching configured server; changing the URL does
not forward an old login. HTTPS is required except for loopback test endpoints.
`DREAMLAKE_REMOTE` and `DREAMLAKE_API_KEY` support explicit existing environments;
no command accepts a token argument. `ML_DASH_MANAGED_CONFIG_DIR` selects an
isolated shared-login directory for tests or an explicit alternate environment.

Namespace/project/credential pages retain opaque `nextCursor` values. Repeat the
same list with `--cursor` to continue. Exact project/run/file selection traverses
bounded cursor pages, fails on repeated cursors, and never calls the first page
complete. Organization member arrays use the existing typed GraphQL API, which
has no server pagination; the response identifies that fact.

By default all these management commands use DreamLake authority. Explicit
`--standalone` uses the separate Dash config and login; neither credential is
forwarded to the other system. Standalone organization/member/team lists use the
companion paginated GraphQL queries with `--limit` and `--offset`/`nextOffset`.
`teams list|members --standalone` is diagnostic inspection; team membership is
not a project data ACL. Standalone instance inspection reads
`/.well-known/dash-experiments`, which exposes protocol/capability enablement,
not an invented running binary version.

Organization create/update actions use typed GraphQL and exact reviewed metadata.
DreamLake organization deletion is intentionally disabled with
`OWNERSHIP_LIFECYCLE_UNSUPPORTED`; resource/secret retention manifests are absent.
Standalone `orgs delete --standalone` requires the companion server's advertised
transactional empty-only soft-delete capability, refuses visible projects, and
relies on the server to atomically include soft-deleted projects in its guard.
It never calls an old hard-delete implementation.

Organization member add/role/remove actions require an OWNER and a reviewed
snapshot of the current membership. Use explicit user IDs and roles, never a
name guess. These update DreamLake only; no Dash memberships are copied or unioned.

```sh
ml-dash orgs member-add --namespace fortyfive --user USER_ID --role MEMBER --out member-review.json --json
ml-dash orgs member-add --namespace fortyfive --user USER_ID --role MEMBER --apply --review member-review.json --json
```

## Setup: exact preview, receipt and recovery

```sh
ml-dash setup plan --namespace fortyfive --project research-harness --out setup-review.json --json
# Review stable namespace/project/instance IDs, resources, revision and planHash.
ml-dash setup apply --namespace fortyfive --project research-harness --apply --review setup-review.json --idempotency-key SETUP_INTENT_ID --out setup-receipt.json --json
ml-dash setup status --namespace fortyfive --project research-harness --json
```

The CLI submits only the reviewed `expectedRevision`, `planHash` and stable
`idempotencyKey`; the server owns actual provisioning and a durable receipt.
`setup plan` makes only reads. A changed review is refused. Review and receipt
files use exclusive creation and contain no tokens. Retain both after success.

If a response is lost, inspect status before retrying. Reuse the **same** review
and intent key with `setup resume`; it replays the original intent rather than
substituting the latest revision or a different target. The server validates
that replay against its durable receipt. An unrelated owner or changed resource
cannot silently win the retry. The CLI validates the returned receipt's stable
namespace/project/instance IDs, revision and intent key.

```sh
ml-dash setup resume --namespace fortyfive --project research-harness --apply --review setup-review.json --idempotency-key SETUP_INTENT_ID --json
```

## Scoped workload credentials and logging

Credential commands expose metadata only. `create` requires a stable UUID intent
key; rotation and retirement require the currently reviewed generation. Workload
credential management is limited to the actual requester; an organization role
does not silently adopt another person's writer. The server controls expiry,
revocation and current project authorization on renewal. Already issued
capabilities may remain usable for the documented short TTL plus clock skew.

```sh
ml-dash credentials list --namespace fortyfive --project research-harness --json
ml-dash credentials create --namespace fortyfive --project research-harness --run RUN_ID --idempotency-key UUID_INTENT --out writer-review.json --json
ml-dash credentials create --namespace fortyfive --project research-harness --run RUN_ID --idempotency-key UUID_INTENT --apply --review writer-review.json --json
ml-dash credentials inspect --namespace fortyfive --project research-harness --credential WRITER_ID --json
ml-dash credentials rotate --namespace fortyfive --project research-harness --credential WRITER_ID --expected-generation 1 --out rotate-review.json --json
ml-dash credentials rotate --namespace fortyfive --project research-harness --credential WRITER_ID --expected-generation 1 --apply --review rotate-review.json --json
```

Use `retire` with the same review/apply pattern to revoke future use/renewal.
There is no `export-token` command. A first write can use a stable UUID
`--idempotency-key`; a known writer uses `--credential WRITER_ID`. Returned
workload metadata includes the writer ID, generation and expiry, never its token.
A run-scoped writer can write only its bound run. Reads use the BFF, preserving
current DreamLake authorization.

```sh
ml-dash runs create --namespace fortyfive --project research-harness --run-key training-001 --idempotency-key UUID_INTENT --out run-review.json --json
ml-dash runs create --namespace fortyfive --project research-harness --run-key training-001 --idempotency-key UUID_INTENT --apply --review run-review.json --json
ml-dash runs list --namespace fortyfive --project research-harness --json
ml-dash runs show --namespace fortyfive --project research-harness --run RUN_ID --json
ml-dash metrics list --namespace fortyfive --project research-harness --run RUN_ID --json
ml-dash metrics read --namespace fortyfive --project research-harness --run RUN_ID --metric loss --limit 100 --json
ml-dash logs read --namespace fortyfive --project research-harness --run RUN_ID --limit 100 --json
ml-dash files list --namespace fortyfive --project research-harness --run RUN_ID --json
```

`metrics append` accepts `--data points.json` as a 1–1000-point JSON array.
`logs append` accepts 1–1000 log entries; each contains timestamp, level and
message. `runs parameters` accepts a JSON object; `runs status --status COMPLETED`
updates lifecycle status. `runs parameters` without `--data` reads current
parameters. `runs delete` requires its own exact preview/apply and acquires a
separate capability whose only action is `delete`; ordinary writer sessions are
not expanded. It soft-deletes the experiment record while retaining underlying
logs, metrics, parameters and files. Each write uses the same default-preview then
`--apply --review` pattern. A saved workload review binds stable resources,
operation, credential intent and payload hash. Changing input after approval is
refused before acquiring a scoped session. Non-idempotent log/metric append is
**not** automatically retried after an unknown network outcome.

Managed file upload is `files upload --input ./artifact.txt`, with the same review
pattern. It supports one flat filename and at most 8 MiB per attachment; this is
the managed API limit, not a new limit on standalone streaming upload/download.
The CLI never prints base64 payloads. Download uses a user-selected path:

```sh
ml-dash files download --namespace fortyfive --project research-harness --run RUN_ID --file FILE_ID --out ./artifact-copy.txt --json
```

Download verifies byte count and SHA-256 before atomically installing the file,
ignores a server-supplied filename as a path, and refuses an existing destination.
No presigned or persistent storage credential is exported.

## Diagnostics and advanced external workspaces

```sh
ml-dash health check --json
ml-dash diagnostics check --namespace fortyfive --project research-harness --json
ml-dash connections list --namespace fortyfive --json
ml-dash workspaces list --namespace fortyfive --connection APPROVED_ALIAS --json
ml-dash workspaces status --namespace fortyfive --json
ml-dash workspaces plan --namespace fortyfive --connection APPROVED_ALIAS --remote-namespace REMOTE_ID --out external-review.json --json
ml-dash workspaces apply --namespace fortyfive --connection APPROVED_ALIAS --remote-namespace REMOTE_ID --apply --review external-review.json --json
```

Managed setup is the default path; external connection management is advanced.
Only operator-approved aliases are accepted. Discovery verifies the external
instance and eligible workspace. No URL/token is supplied by the user, and equal
organization names never establish a mapping. Applying pins the reviewed
instance/namespace/alias and current binding revision. `workspaces detach`
previews by default and applies with the same saved-review pattern. Detachment
is local, retains remote data, and does not depend on external discovery.

## Legacy project adoption

`adoption inventory` reads the explicit legacy project; `adoption plan` requests
a server-generated exact plan against its current authority revision. The BFF
owns separate requester/legacy-owner checks and adoption authorization. A normal
managed writer is never an adoption credential.

```sh
ml-dash adoption inventory --namespace fortyfive --project research-harness --remote-project LEGACY_PROJECT_ID --json
ml-dash adoption plan --namespace fortyfive --project research-harness --remote-project LEGACY_PROJECT_ID --expected-revision REMOTE_REVISION --out adoption-review.json --json
ml-dash adoption apply --namespace fortyfive --project research-harness --remote-project LEGACY_PROJECT_ID --apply --review adoption-review.json --idempotency-key ADOPTION_INTENT --json
ml-dash adoption reconcile --namespace fortyfive --project research-harness --remote-project LEGACY_PROJECT_ID --plan-hash PLAN_HASH --json
```

Apply replaces authority according to the reviewed policy rather than unioning
old and new memberships. It requires operator fencing, backup and write draining;
it is disabled until those server preconditions are provided. A precondition
error is a real blocker, never a successful adoption. Recovery uses the same
review, `--expected-revision` from current authority and a stable intent key.
No CLI flag enables server fencing or bypasses these safeguards.

## Output and backend mapping

All commands offer `--json`: success is `{ok:true,data}`, failure is
`{ok:false,error:{code,message,remediation,retryable}}` with nonzero exit status.
Human output contains the same non-secret data, plus a concise status. Upstream
raw error bodies, login tokens, scoped tokens and file base64 are excluded.

| Surface | Actual API |
|---|---|
| Login/status | Vuer device start/poll; DreamLake `/auth/exchange`, `/auth/me` |
| Instance/discovery | BFF `/managed-experiments/capabilities`, `/namespaces`, `/ns/:ns/projects` |
| Organization membership | Fixed typed DreamLake GraphQL operations; no user-supplied query |
| Setup/status | BFF project `/setup`, `/status` with durable CAS/intent receipt |
| Credentials | BFF project `/credentials`, `/credentials/:id`; scoped `/session` only in memory |
| Reads | BFF project `/runs`, metrics/logs/files and verified file download |
| Writes | Dash `/api/managed/projects/:stableId/runs/...` with short scoped session |
| External workspaces | BFF `/integrations/dash/ns/:ns/connections`, `/workspaces`, `/binding` |
| Adoption | BFF project `/adoption/:legacyProjectId/{inventory,plan,apply,reconcile,recover}` |
