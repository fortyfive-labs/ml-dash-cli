# Changelog

## 0.3.0 — Release candidate

- Complete managed organization member/team and external connection/workspace pagination.
- Fix `orgs teams` routing and preserve DreamLake VISIBLE/SECRET semantics.
- Add offline command schema and versioned authenticated operation JSON Schema discovery. Reject unsupported protocol/schema versions.
- Requires the matching BFF release. Not yet published; 0.2.0 remains the public version until release succeeds.

## 0.2.0 — Managed Experiments administration (2026-10-16)

- Add typed auth, instance, organization/membership, project/effective-access,
  setup plan/apply/status/resume, scoped workload credential lifecycle,
  experiment run/parameters/metrics/logs/files, health and diagnostics commands.
- Managed control commands use the existing DreamLake login. Explicit
  `--standalone` inspection/organization commands use the independent Dash
  login; tokens are never copied across these authorities.
- Setup uses exact server plans, CAS revisions and durable idempotent receipts.
  Workload changes require a saved review and validate unchanged resources and
  payloads before minting in-memory scoped credentials. Delete is a separate
  capability; ordinary write is not expanded.
- Verify file downloads by size/SHA-256, atomically refuse destination races,
  retain remote data on run soft deletion, and preserve opaque cursors or
  server-provided offset pagination. Fix missing `hasMore` in existing client
  project/experiment/search pages.
- Add explicit operator-approved external connection/workspace commands and
  legacy adoption inventory/plan/apply/reconcile/recover commands. Adoption
  cannot bypass server fencing, backup, drain or feature preconditions.
- Preserve stable GraphQL and HTTP errors without echoing secret-bearing error
  bodies. Human and JSON management output contain the same non-secret data.
- Keep all existing standalone commands and Python SDK compatibility. This is
  an additive minor release, not a new logging protocol or SDK replacement.

Requires companion DreamLake/Dash managed endpoints and the paginated standalone
inspection API. DreamLake organization deletion remains intentionally disabled;
standalone organization deletion requires the hardened empty-only soft-delete
capability. Source-backed storage and production migration are excluded.

Publication, default-channel movement, hosted docs, real credentials and
production acceptance have not been performed by this preparation.

## 0.1.2

Existing TypeScript CLI baseline, including the macOS long-token keychain fix.
