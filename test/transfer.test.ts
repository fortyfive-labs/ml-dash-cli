/**
 * Behaviour tests for `upload` and `download`.
 *
 * Every assertion is made against something outside the CLI process: the
 * requests the fake server actually received, or the bytes that ended up on
 * disk. Nothing here calls the command's own modules, because the failure this
 * is guarding against — a transfer that finishes 0 while moving no data — is
 * invisible to a test that asks the uploader what it thinks it uploaded.
 *
 * The local fixtures are written literally rather than through `LocalStorage`,
 * so a change to the writer cannot silently redefine what the reader is
 * expected to find.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { defaultState, type FakeState } from "./fake-server.js";
import { harness, type Harness } from "./harness.js";

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

const FILE_ID = "1700000000000000001";
const FILE_BODY = Buffer.from("weights: 0.125\n");

/** Read a JSONL file into objects. */
const readJsonl = (file: string): any[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

/**
 * A `.dash` experiment on disk: both metric layouts, logs with two junk
 * lines, parameters and one file.
 */
function writeExperiment(
  root: string,
  prefix: string,
  opts: { project: string; name: string } = { project: "alpha", name: "exp-one" },
): string {
  const dir = path.join(root, ...prefix.split("/"));
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  mkdirSync(path.join(dir, "metrics", "loss"), { recursive: true });
  mkdirSync(path.join(dir, "files", "checkpoints", FILE_ID), { recursive: true });

  writeFileSync(
    path.join(dir, "experiment.json"),
    JSON.stringify({
      name: opts.name,
      project: opts.project,
      description: "a description",
      tags: ["baseline"],
      bindrs: [],
      prefix,
      metadata: { seed: 7 },
      created_at: "2026-01-01T00:00:00Z",
      write_protected: false,
    }),
  );
  writeFileSync(
    path.join(dir, "parameters.json"),
    JSON.stringify({ version: 1, data: { lr: 0.01, batch: 32 }, updatedAt: "2026-01-01T00:00:00Z" }),
  );

  // Two of these five lines are unusable: one is not JSON, one has no message.
  writeFileSync(
    path.join(dir, "logs", "logs.jsonl"),
    [
      JSON.stringify({ sequenceNumber: 0, timestamp: "2026-01-01T00:00:00Z", level: "info", message: "start" }),
      "{not json",
      JSON.stringify({ sequenceNumber: 1, timestamp: "2026-01-01T00:00:01Z", level: "warning", message: "careful", metadata: { step: 1 } }),
      JSON.stringify({ sequenceNumber: 2, timestamp: "2026-01-01T00:00:02Z", level: "info" }),
      JSON.stringify({ sequenceNumber: 3, timestamp: "2026-01-01T00:00:03Z", level: "error", message: "done" }),
      "",
    ].join("\n"),
  );

  // Directory layout — what the current SDK writes.
  writeFileSync(
    path.join(dir, "metrics", "loss", "data.jsonl"),
    [
      JSON.stringify({ index: 0, data: { step: 0, loss: 1.5 }, createdAt: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ index: 1, data: { step: 1, loss: 1.25 }, createdAt: "2026-01-01T00:00:01Z" }),
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(dir, "metrics", "loss", "metadata.json"),
    JSON.stringify({ name: "loss", totalDataPoints: 2, nextIndex: 2 }),
  );
  // Flat layout — what `write_metric_data` writes, and what the Python CLI
  // never uploaded.
  writeFileSync(
    path.join(dir, "metrics", "acc.jsonl"),
    [
      JSON.stringify({ data: { step: 0, acc: 0.4 } }),
      JSON.stringify({ data: { step: 1, acc: 0.8 } }),
      "",
    ].join("\n"),
  );

  writeFileSync(path.join(dir, "files", "checkpoints", FILE_ID, "model.bin"), FILE_BODY);
  writeFileSync(
    path.join(dir, "files", ".files_metadata.json"),
    JSON.stringify({
      files: [
        {
          id: FILE_ID,
          experimentId: `${opts.project}/${prefix}`,
          path: "checkpoints",
          filename: "model.bin",
          description: "the checkpoint",
          tags: ["ckpt"],
          bindrs: [],
          contentType: "application/octet-stream",
          sizeBytes: FILE_BODY.length,
          checksum: sha256(FILE_BODY),
          metadata: { epoch: 3 },
          uploadedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          deletedAt: null,
        },
      ],
    }),
  );
  return dir;
}

/** A server holding one experiment's worth of downloadable data. */
function stateWithRemoteData(): FakeState {
  const state = defaultState();
  state.transfer.parameters = { lr: 0.5, optimizer: "adam" };
  state.transfer.logs = [
    { sequenceNumber: 0, timestamp: "2026-03-01T00:00:00Z", level: "info", message: "remote one" },
    { sequenceNumber: 1, timestamp: "2026-03-01T00:00:01Z", level: "error", message: "remote two", metadata: { step: 9 } },
  ];
  state.transfer.metrics = {
    loss: {
      chunks: [[{ index: 0, data: { step: 0, loss: 3 } }, { index: 1, data: { step: 1, loss: 2 } }]],
      buffer: [{ index: 2, data: { step: 2, loss: 1 } }],
    },
  };
  state.transfer.files = [
    {
      id: FILE_ID,
      name: "model.bin",
      pPath: "checkpoints",
      description: "the checkpoint",
      tags: ["ckpt"],
      metadata: { epoch: 3 },
      createdAt: "2026-03-01T00:00:00Z",
      physicalFile: {
        id: "1800000000000000001",
        filename: "model.bin",
        contentType: "application/octet-stream",
        sizeBytes: FILE_BODY.length,
        checksum: sha256(FILE_BODY),
        s3Url: null,
      },
    },
  ];
  state.transfer.fileBodies = { [FILE_ID]: FILE_BODY };
  return state;
}

const uploadedFile = (h: Harness) => h.server.state.transfer.receivedFiles[0];

// ── upload ───────────────────────────────────────────────────────────────────

describe("upload", () => {
  test("moves parameters, logs, both metric layouts and files to the server", async (t) => {
    const h = await harness(t);
    await h.login();
    const root = path.join(h.configDir, "dash");
    writeExperiment(root, "test-user/alpha/exp-one");

    const r = await h.cli(["upload", root, "--dash-url", h.server.url, "-v"]);
    assert.equal(r.code, 0, r.out);

    const created = h.server.requests.find(
      (q) => q.method === "POST" && q.path === "/api/namespaces/test-user/nodes" && q.body?.type === "EXPERIMENT",
    );
    assert.ok(created, "no experiment node was created");
    assert.equal(created.body.name, "exp-one");
    assert.equal(created.body.description, "a description");
    // The prefix is not a field on the node API: the server places an
    // experiment by its parent, so a flat prefix means parentId ROOT.
    assert.equal(created.body.parentId, "ROOT");
    assert.deepEqual(created.body.tags, ["baseline"]);
    assert.deepEqual(created.body.metadata, { seed: 7 });

    const transfer = h.server.state.transfer;
    const experimentId = Object.keys(transfer.receivedLogs)[0];

    assert.deepEqual(transfer.receivedParameters[experimentId], { lr: 0.01, batch: 32 });

    // The two unusable lines are skipped; the other three arrive in order,
    // with their level and metadata intact.
    const logs = transfer.receivedLogs[experimentId];
    assert.equal(logs.length, 3);
    assert.deepEqual(
      logs.map((l: any) => l.message),
      ["start", "careful", "done"],
    );
    assert.equal(logs[1].level, "warning");
    assert.deepEqual(logs[1].metadata, { step: 1 });

    const metrics = transfer.receivedMetrics[experimentId];
    assert.deepEqual(Object.keys(metrics).sort(), ["acc", "loss"]);
    assert.deepEqual(metrics.loss, [
      { step: 0, loss: 1.5 },
      { step: 1, loss: 1.25 },
    ]);
    assert.deepEqual(metrics.acc, [
      { step: 0, acc: 0.4 },
      { step: 1, acc: 0.8 },
    ]);

    const file = uploadedFile(h);
    assert.ok(file, "no file was uploaded");
    assert.equal(file.filename, "model.bin");
    assert.equal(file.data.toString("utf8"), FILE_BODY.toString("utf8"));
    assert.equal(file.checksum, sha256(file.data), "the checksum sent does not describe the bytes sent");
    assert.equal(file.fields.name, "model.bin");
    assert.equal(file.fields.type, "FILE");
    assert.equal(file.fields.experimentId, experimentId);

    assert.match(r.stdout, /3 log entries/);
    assert.match(r.stdout, /2 metrics/);
    assert.match(r.stdout, /1 files/);
  });

  test("a nested prefix becomes a folder chain on the server", async (t) => {
    const h = await harness(t);
    await h.login();
    const root = path.join(h.configDir, "dash");
    writeExperiment(root, "test-user/alpha/folder-a/exp-nested", {
      project: "alpha",
      name: "exp-nested",
    });

    const r = await h.cli(["upload", root, "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);

    const folder = h.server.requests.find((q) => q.body?.type === "FOLDER" && q.body?.name === "folder-a");
    assert.ok(folder, "the folder named in the prefix was never created");
    assert.equal(folder.body.parentId, "ROOT");
    assert.equal(
      folder.body.experimentId,
      undefined,
      "a project-level folder was tagged with an experiment id",
    );

    const created = h.server.requests.find((q) => q.body?.type === "EXPERIMENT");
    assert.ok(created);
    assert.equal(created.body.name, "exp-nested");
    assert.equal(created.body.parentId, "5555555555555555555", "the experiment was not placed under the folder");
  });

  test("--dry-run sends nothing at all", async (t) => {
    const h = await harness(t);
    await h.login();
    const root = path.join(h.configDir, "dash");
    writeExperiment(root, "test-user/alpha/exp-one");
    const before = h.server.requests.length;

    const r = await h.cli(["upload", root, "--dash-url", h.server.url, "--dry-run"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /DRY RUN/);
    assert.match(r.stdout, /alpha\/exp-one/);
    assert.equal(
      h.server.requests.slice(before).filter((q) => q.method === "POST").length,
      0,
      "a dry run posted to the server",
    );
  });

  test("skip flags leave those sections untouched", async (t) => {
    const h = await harness(t);
    await h.login();
    const root = path.join(h.configDir, "dash");
    writeExperiment(root, "test-user/alpha/exp-one");

    const r = await h.cli([
      "upload", root, "--dash-url", h.server.url,
      "--skip-metrics", "--skip-files", "--skip-params",
    ]);
    assert.equal(r.code, 0, r.out);

    const transfer = h.server.state.transfer;
    assert.deepEqual(transfer.receivedMetrics, {});
    assert.deepEqual(transfer.receivedParameters, {});
    assert.equal(transfer.receivedFiles.length, 0);
    assert.equal(Object.values(transfer.receivedLogs)[0]?.length, 3, "logs were skipped too");
  });

  test("a failing section fails the run, keeps the state file and exits 1", async (t) => {
    const state = defaultState();
    state.transfer.failPath = "/logs";
    const h = await harness(t, state);
    await h.login();
    const root = path.join(h.configDir, "dash");
    writeExperiment(root, "test-user/alpha/exp-one");
    const stateFile = path.join(h.configDir, "upload-state.json");

    const r = await h.cli([
      "upload", root, "--dash-url", h.server.url, "--state-file", stateFile,
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Failed/);
    assert.ok(existsSync(stateFile), "the state file was deleted after a failure");
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(saved.failed_experiments, ["alpha/exp-one"]);
    assert.deepEqual(saved.completed_experiments, []);
  });

  test("a clean run removes its state file", async (t) => {
    const h = await harness(t);
    await h.login();
    const root = path.join(h.configDir, "dash");
    writeExperiment(root, "test-user/alpha/exp-one");
    const stateFile = path.join(h.configDir, "upload-state.json");

    const r = await h.cli(["upload", root, "--dash-url", h.server.url, "--state-file", stateFile]);
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(stateFile));
  });

  test("--resume skips experiments the state file already completed", async (t) => {
    const h = await harness(t);
    await h.login();
    const root = path.join(h.configDir, "dash");
    writeExperiment(root, "test-user/alpha/exp-one");
    writeExperiment(root, "test-user/alpha/exp-two", { project: "alpha", name: "exp-two" });

    const stateFile = path.join(h.configDir, "upload-state.json");
    writeFileSync(
      stateFile,
      JSON.stringify({
        dash_root: root,
        remote_url: h.server.url,
        completed_experiments: ["alpha/exp-one"],
        failed_experiments: [],
        in_progress_experiment: null,
        timestamp: "2026-01-01T00:00:00Z",
      }),
    );

    const r = await h.cli([
      "upload", root, "--dash-url", h.server.url, "--resume", "--state-file", stateFile,
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Skipping 1 already completed/);

    const names = h.server.requests
      .filter((q) => q.body?.type === "EXPERIMENT")
      .map((q) => q.body.name);
    assert.deepEqual(names, ["exp-two"], "resume re-uploaded a completed experiment");
  });

  test("a glob -p selects a subset of the tree", async (t) => {
    const h = await harness(t);
    await h.login();
    const root = path.join(h.configDir, "dash");
    writeExperiment(root, "test-user/alpha/exp-one");
    writeExperiment(root, "test-user/alpha/exp-two", { project: "alpha", name: "exp-two" });

    const r = await h.cli([
      "upload", root, "--dash-url", h.server.url, "-p", "test-user/*/exp-two",
    ]);
    assert.equal(r.code, 0, r.out);
    const names = h.server.requests
      .filter((q) => q.body?.type === "EXPERIMENT")
      .map((q) => q.body.name);
    assert.deepEqual(names, ["exp-two"]);
  });

  test("-t retargets the experiment at another namespace and project", async (t) => {
    const h = await harness(t);
    await h.login();
    const root = path.join(h.configDir, "dash");
    writeExperiment(root, "test-user/alpha/exp-one");

    const r = await h.cli([
      "upload", root, "--dash-url", h.server.url, "-t", "alice/shared-project",
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Target prefix: alice\/shared-project/);

    const created = h.server.requests.find((q) => q.body?.type === "EXPERIMENT");
    assert.ok(created);
    assert.equal(created.path, "/api/namespaces/alice/nodes", "the target namespace was not used");
    assert.equal(created.body.projectSlug, "shared-project");
  });

  test("--strict turns a warning into a refusal to upload", async (t) => {
    const h = await harness(t);
    await h.login();
    const root = path.join(h.configDir, "dash");
    // The fixture's logs.jsonl carries two unusable lines, which is a warning.
    writeExperiment(root, "test-user/alpha/exp-one");
    const before = h.server.requests.length;

    const r = await h.cli(["upload", root, "--dash-url", h.server.url, "--strict"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Validation failed in --strict mode/);
    assert.equal(
      h.server.requests.slice(before).filter((q) => q.body?.type === "EXPERIMENT").length,
      0,
      "--strict uploaded anyway",
    );
  });

  test("a missing local path exits 1 without contacting the server", async (t) => {
    const h = await harness(t);
    await h.login();
    const before = h.server.requests.length;
    const r = await h.cli(["upload", path.join(h.configDir, "nope"), "--dash-url", h.server.url]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not exist/);
    assert.equal(h.server.requests.length, before);
  });
});

// ── download ─────────────────────────────────────────────────────────────────

describe("download", () => {
  test("writes parameters, logs, metric points and a verified file to disk", async (t) => {
    const h = await harness(t, stateWithRemoteData());
    await h.login();
    const root = path.join(h.configDir, "dash");

    const r = await h.cli([
      "download", root, "--dash-url", h.server.url,
      "-p", "test-user/alpha", "--experiment", "exp-one", "-v",
    ]);
    assert.equal(r.code, 0, r.out);

    const dir = path.join(root, "test-user", "alpha", "exp-one");
    const experiment = JSON.parse(readFileSync(path.join(dir, "experiment.json"), "utf8"));
    assert.equal(experiment.name, "exp-one");
    assert.equal(experiment.prefix, "test-user/alpha/exp-one");

    const params = JSON.parse(readFileSync(path.join(dir, "parameters.json"), "utf8"));
    assert.deepEqual(params.data, { lr: 0.5, optimizer: "adam" });

    const logs = readJsonl(path.join(dir, "logs", "logs.jsonl"));
    assert.deepEqual(
      logs.map((l) => l.message),
      ["remote one", "remote two"],
    );
    assert.equal(logs[1].level, "error");
    assert.deepEqual(logs[1].metadata, { step: 9 });

    // Chunked points and the open buffer arrive together, in index order.
    const points = readJsonl(path.join(dir, "metrics", "loss", "data.jsonl"));
    assert.deepEqual(
      points.map((p) => p.data),
      [
        { step: 0, loss: 3 },
        { step: 1, loss: 2 },
        { step: 2, loss: 1 },
      ],
    );

    const filesMeta = JSON.parse(readFileSync(path.join(dir, "files", ".files_metadata.json"), "utf8"));
    assert.equal(filesMeta.files.length, 1);
    const record = filesMeta.files[0];
    assert.equal(record.filename, "model.bin");
    assert.equal(record.path, "checkpoints");
    assert.equal(record.checksum, sha256(FILE_BODY));
    const onDisk = path.join(dir, "files", "checkpoints", record.id, "model.bin");
    assert.equal(readFileSync(onDisk, "utf8"), FILE_BODY.toString("utf8"));
    assert.match(record.id, /^\d+$/, "the local file id is not a string Snowflake");

    // The metric fallback only runs when the chunk path fails; it did not.
    assert.ok(
      h.server.requests.some((q) => q.path.endsWith("/metrics/loss/chunks/0")),
      "chunks were never fetched",
    );
  });

  test("a checksum mismatch deletes the download and exits non-zero", async (t) => {
    const state = stateWithRemoteData();
    // The server still advertises the good checksum; the bytes are not it.
    state.transfer.fileBodies[FILE_ID] = Buffer.from("corrupted\n");
    const h = await harness(t, state);
    await h.login();
    const root = path.join(h.configDir, "dash");

    const r = await h.cli([
      "download", root, "--dash-url", h.server.url,
      "-p", "test-user/alpha", "--experiment", "exp-one",
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /checksum mismatch/);

    const filesDir = path.join(root, "test-user", "alpha", "exp-one", "files");
    const metadataFile = path.join(filesDir, ".files_metadata.json");
    if (existsSync(metadataFile)) {
      assert.deepEqual(JSON.parse(readFileSync(metadataFile, "utf8")).files, []);
    }
    const stray = existsSync(filesDir)
      ? readdirSync(filesDir).filter((n) => !n.startsWith("."))
      : [];
    assert.deepEqual(stray, [], "a corrupt file was left in the tree");
  });

  test("--dry-run writes nothing", async (t) => {
    const h = await harness(t, stateWithRemoteData());
    await h.login();
    const root = path.join(h.configDir, "dash");

    const r = await h.cli([
      "download", root, "--dash-url", h.server.url, "-p", "test-user/alpha", "--dry-run",
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Dry run - would download/);
    assert.ok(!existsSync(path.join(root, "test-user", "alpha", "exp-one", "experiment.json")));
  });

  test("an experiment already on disk is skipped unless --overwrite", async (t) => {
    const h = await harness(t, stateWithRemoteData());
    await h.login();
    const root = path.join(h.configDir, "dash");
    const args = [
      "download", root, "--dash-url", h.server.url, "-p", "test-user/alpha", "--experiment", "exp-one",
    ];

    assert.equal((await h.cli(args)).code, 0);
    const second = await h.cli(args);
    assert.equal(second.code, 0, second.out);
    assert.match(second.stdout, /already exists locally/);

    const before = h.server.requests.length;
    const third = await h.cli([...args, "--overwrite"]);
    assert.equal(third.code, 0, third.out);
    assert.ok(h.server.requests.length > before, "--overwrite fetched nothing");
  });

  test("--skip-metrics and --skip-files leave those out", async (t) => {
    const h = await harness(t, stateWithRemoteData());
    await h.login();
    const root = path.join(h.configDir, "dash");

    const r = await h.cli([
      "download", root, "--dash-url", h.server.url, "-p", "test-user/alpha",
      "--experiment", "exp-one", "--skip-metrics", "--skip-files",
    ]);
    assert.equal(r.code, 0, r.out);
    const dir = path.join(root, "test-user", "alpha", "exp-one");
    assert.ok(!existsSync(path.join(dir, "metrics", "loss")));
    assert.deepEqual(readdirSync(path.join(dir, "files")), []);
    assert.ok(existsSync(path.join(dir, "logs", "logs.jsonl")), "logs were skipped too");
  });

  test("-p without a namespace is rejected before any request", async (t) => {
    const h = await harness(t);
    await h.login();
    const before = h.server.requests.length;
    const r = await h.cli(["download", "--dash-url", h.server.url, "-p", "alpha"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /must be in format 'namespace\/project'/);
    assert.equal(h.server.requests.length, before);
  });

  test("--resume skips what the state file already completed", async (t) => {
    const h = await harness(t, stateWithRemoteData());
    await h.login();
    const root = path.join(h.configDir, "dash");
    const stateFile = path.join(h.configDir, "download-state.json");
    writeFileSync(
      stateFile,
      JSON.stringify({
        remote_url: h.server.url,
        local_path: root,
        completed_experiments: ["alpha/exp-one"],
        failed_experiments: [],
        in_progress_experiment: null,
        timestamp: "2026-01-01T00:00:00Z",
      }),
    );

    const r = await h.cli([
      "download", root, "--dash-url", h.server.url, "-p", "test-user/alpha",
      "--experiment", "exp-one", "--resume", "--state-file", stateFile,
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /already completed/);
    assert.ok(!existsSync(path.join(root, "test-user", "alpha", "exp-one", "experiment.json")));
  });
});

// ── round trip ───────────────────────────────────────────────────────────────

describe("upload then download", () => {
  test("what upload sent is what download writes back", async (t) => {
    const h = await harness(t);
    await h.login();
    const source = path.join(h.configDir, "source");
    writeExperiment(source, "test-user/alpha/exp-one");

    assert.equal((await h.cli(["upload", source, "--dash-url", h.server.url])).code, 0);

    // Feed everything the server received back out of it.
    const transfer = h.server.state.transfer;
    const experimentId = Object.keys(transfer.receivedLogs)[0];
    transfer.parameters = transfer.receivedParameters[experimentId];
    transfer.logs = transfer.receivedLogs[experimentId];
    transfer.metrics = Object.fromEntries(
      Object.entries(transfer.receivedMetrics[experimentId]).map(([name, points]) => [
        name,
        { chunks: [points.map((data, index) => ({ index, data }))], buffer: [] },
      ]),
    );
    const sent = transfer.receivedFiles[0];
    transfer.files = [
      {
        id: FILE_ID,
        name: sent.filename,
        pPath: sent.fields.name === "model.bin" ? "checkpoints" : "",
        description: sent.fields.description ?? null,
        tags: (sent.fields.tags ?? "").split(",").filter(Boolean),
        metadata: sent.fields.metadata ? JSON.parse(sent.fields.metadata) : null,
        physicalFile: {
          filename: sent.filename,
          contentType: "application/octet-stream",
          sizeBytes: sent.data.length,
          checksum: sent.checksum,
        },
      },
    ];
    transfer.fileBodies = { [FILE_ID]: sent.data };

    const target = path.join(h.configDir, "target");
    const r = await h.cli([
      "download", target, "--dash-url", h.server.url,
      "-p", "test-user/alpha", "--experiment", "exp-one",
    ]);
    assert.equal(r.code, 0, r.out);

    const dir = path.join(target, "test-user", "alpha", "exp-one");
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(dir, "parameters.json"), "utf8")).data,
      { lr: 0.01, batch: 32 },
    );
    assert.deepEqual(
      readJsonl(path.join(dir, "logs", "logs.jsonl")).map((l) => l.message),
      ["start", "careful", "done"],
    );
    assert.deepEqual(
      readJsonl(path.join(dir, "metrics", "loss", "data.jsonl")).map((p) => p.data),
      [
        { step: 0, loss: 1.5 },
        { step: 1, loss: 1.25 },
      ],
    );
    assert.deepEqual(
      readJsonl(path.join(dir, "metrics", "acc", "data.jsonl")).map((p) => p.data),
      [
        { step: 0, acc: 0.4 },
        { step: 1, acc: 0.8 },
      ],
    );
    const record = JSON.parse(readFileSync(path.join(dir, "files", ".files_metadata.json"), "utf8"))
      .files[0];
    assert.equal(
      readFileSync(path.join(dir, "files", "checkpoints", record.id, "model.bin"), "utf8"),
      FILE_BODY.toString("utf8"),
    );
  });
});
