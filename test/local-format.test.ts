/**
 * The `.dash` on-disk format, checked against Python itself.
 *
 * `upload` and `download` are only useful if the tree this CLI writes is the
 * tree the Python SDK reads, and vice versa. A TypeScript-only test cannot
 * establish that: a writer and a reader that agree on the *wrong* layout pass
 * every round trip while being unable to touch a single real experiment. So
 * both directions run through `ml_dash.storage.LocalStorage` in the ml-dash
 * virtualenv:
 *
 *   download → Python reads the parameters, metric points and file record
 *   Python writes an experiment → upload sends its contents to the server
 *
 * The tests skip rather than pass when that interpreter is missing, so a
 * machine without it cannot turn "unchecked" into a green check.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { defaultState } from "./fake-server.js";
import { harness } from "./harness.js";

const PYTHON = "/Users/locatino/fortyfive/ml-dash/.venv/bin/python";
const FILE_BODY = "weights: 0.125\n";
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const pythonStorageAvailable = (): boolean =>
  existsSync(PYTHON) &&
  spawnSync(PYTHON, ["-c", "from ml_dash.storage import LocalStorage"], { stdio: "ignore" }).status === 0;

/** Run a Python snippet and parse the single JSON object it prints. */
function python<T = any>(code: string): T {
  const r = spawnSync(PYTHON, ["-c", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}

describe("local .dash format", { skip: pythonStorageAvailable() ? false : "ml-dash venv not available" }, () => {
  test("Python's LocalStorage reads back what download wrote", async (t) => {
    const state = defaultState();
    state.transfer.parameters = { lr: 0.5, optimizer: "adam" };
    state.transfer.logs = [
      { sequenceNumber: 0, timestamp: "2026-03-01T00:00:00Z", level: "info", message: "remote one" },
    ];
    state.transfer.metrics = {
      loss: { chunks: [[{ index: 0, data: { step: 0, loss: 3 } }]], buffer: [{ index: 1, data: { step: 1, loss: 2 } }] },
    };
    state.transfer.files = [
      {
        id: "1700000000000000001",
        name: "model.bin",
        pPath: "checkpoints",
        description: "the checkpoint",
        tags: ["ckpt"],
        metadata: { epoch: 3 },
        physicalFile: {
          filename: "model.bin",
          contentType: "application/octet-stream",
          sizeBytes: FILE_BODY.length,
          checksum: sha256(FILE_BODY),
        },
      },
    ];
    state.transfer.fileBodies = { "1700000000000000001": Buffer.from(FILE_BODY) };

    const h = await harness(t, state);
    await h.login();
    const root = path.join(h.configDir, "dash");

    const r = await h.cli([
      "download", root, "--dash-url", h.server.url,
      "-p", "test-user/alpha", "--experiment", "exp-one",
    ]);
    assert.equal(r.code, 0, r.out);

    const observed = python(`
import json
from ml_dash.storage import LocalStorage

store = LocalStorage(root_path=${JSON.stringify(root)})
owner, project, prefix = "test-user", "alpha", "test-user/alpha/exp-one"
metric = store.read_metric_data(owner, project, prefix, "loss")
print(json.dumps({
  "parameters": store.read_parameters(owner, project, prefix),
  "metric_points": [p["data"] for p in metric["data"]],
  "metric_total": metric["total"],
  "files": [
    {"filename": f["filename"], "path": f["path"], "checksum": f["checksum"], "tags": f["tags"]}
    for f in store.list_files(owner, project, prefix)
  ],
  # read_file verifies the recorded checksum before copying, so this also
  # proves the checksum download wrote describes the bytes it stored.
  "file_body": open(store.read_file(
    owner, project, prefix,
    store.list_files(owner, project, prefix)[0]["id"],
    dest_path=${JSON.stringify(path.join(root, "_py_readback.bin"))},
  )).read(),
}))
`);

    assert.deepEqual(observed.parameters, { lr: 0.5, optimizer: "adam" });
    assert.deepEqual(observed.metric_points, [
      { step: 0, loss: 3 },
      { step: 1, loss: 2 },
    ]);
    assert.equal(observed.metric_total, 2);
    assert.deepEqual(observed.files, [
      { filename: "model.bin", path: "checkpoints", checksum: sha256(FILE_BODY), tags: ["ckpt"] },
    ]);
    assert.equal(observed.file_body, FILE_BODY);
  });

  test("upload sends the contents of a tree Python wrote", async (t) => {
    const h = await harness(t);
    await h.login();
    const root = path.join(h.configDir, "dash");
    const source = path.join(h.configDir, "model.bin");
    writeFileSync(source, FILE_BODY);

    python(`
import json
from ml_dash.storage import LocalStorage

store = LocalStorage(root_path=${JSON.stringify(root)})
prefix = "test-user/alpha/exp-py"
store.create_experiment(project="alpha", prefix=prefix, description="from python", tags=["py"])
store.write_parameters("test-user", "alpha", prefix, {"lr": 0.02, "epochs": 4})
store.write_log("test-user", "alpha", prefix, message="python log", level="info", timestamp="2026-04-01T00:00:00Z")
store.append_batch_to_metric("test-user", "alpha", prefix, "loss", [{"step": 0, "loss": 9}, {"step": 1, "loss": 8}])
store.write_file(
  "test-user", "alpha", prefix,
  file_path=${JSON.stringify(source)},
  path="checkpoints",
  filename="model.bin",
  checksum=${JSON.stringify(sha256(FILE_BODY))},
  content_type="application/octet-stream",
  size_bytes=${FILE_BODY.length},
)
print(json.dumps({"ok": True}))
`);

    const r = await h.cli(["upload", root, "--dash-url", h.server.url]);
    assert.equal(r.code, 0, r.out);

    const transfer = h.server.state.transfer;
    const experimentId = Object.keys(transfer.receivedLogs)[0];
    assert.deepEqual(transfer.receivedParameters[experimentId], { lr: 0.02, epochs: 4 });
    assert.deepEqual(
      transfer.receivedLogs[experimentId].map((l: any) => l.message),
      ["python log"],
    );
    assert.deepEqual(transfer.receivedMetrics[experimentId].loss, [
      { step: 0, loss: 9 },
      { step: 1, loss: 8 },
    ]);
    assert.equal(transfer.receivedFiles.length, 1);
    assert.equal(transfer.receivedFiles[0].filename, "model.bin");
    assert.equal(transfer.receivedFiles[0].data.toString("utf8"), FILE_BODY);
    assert.equal(transfer.receivedFiles[0].checksum, sha256(FILE_BODY));

    // The experiment.json Python wrote names the experiment, not the folder.
    const created = h.server.requests.find((q) => q.body?.type === "EXPERIMENT");
    assert.ok(created);
    assert.equal(created.body.name, "exp-py");
    assert.equal(created.body.description, "from python");
  });
});
