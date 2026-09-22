/**
 * Fernet interoperability with Python's `cryptography`.
 *
 * The fallback credential store reuses ~/.dash/tokens.encrypted and
 * ~/.dash/encryption.key, which the Python CLI writes with
 * `cryptography.fernet.Fernet`. A self-consistent implementation proves
 * nothing here: wrong-but-symmetric code encrypts and decrypts its own tokens
 * perfectly while being unable to read a single real one. So both directions
 * are checked against Python itself, running in the ml-dash virtualenv.
 *
 * The test skips (rather than passes) when that interpreter is absent, so a
 * machine without it cannot turn "unverified" into a green check.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";
import { decrypt, encrypt, generateKey } from "../src/auth/fernet.js";

const PYTHON = "/Users/locatino/fortyfive/ml-dash/.venv/bin/python";

const pythonFernetAvailable = (): boolean =>
  existsSync(PYTHON) &&
  spawnSync(PYTHON, ["-c", "import cryptography.fernet"], { stdio: "ignore" }).status === 0;

function python(code: string): string {
  const r = spawnSync(PYTHON, ["-c", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

describe("fernet interop with Python cryptography", { skip: pythonFernetAvailable() ? false : "python cryptography not available" }, () => {
  test("decrypts a token Python produced", () => {
    const out = python(
      "from cryptography.fernet import Fernet\n" +
        "k = Fernet.generate_key()\n" +
        "print(k.decode())\n" +
        "print(Fernet(k).encrypt(b'ml-dash-token-value').decode())",
    );
    const [key, token] = out.split("\n");
    assert.equal(decrypt(key, token).toString("utf8"), "ml-dash-token-value");
  });

  test("produces a token Python accepts, with a key Python accepts", () => {
    const key = generateKey();
    const token = encrypt(key, Buffer.from('{"ml-dash-token":"abc123"}', "utf8"));
    const out = python(
      "from cryptography.fernet import Fernet\n" +
        `print(Fernet(${JSON.stringify(key)}.encode()).decrypt(${JSON.stringify(token)}.encode()).decode())`,
    );
    assert.equal(out, '{"ml-dash-token":"abc123"}');
  });

  test("a token signed with a different key is rejected, not silently mis-decrypted", () => {
    const token = encrypt(generateKey(), Buffer.from("secret", "utf8"));
    assert.throws(() => decrypt(generateKey(), token), /signature does not verify/);
  });
});
