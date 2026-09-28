/**
 * macOS keychain writes must keep a long token intact.
 *
 * The old write fed the token to `security add-generic-password -w` as a
 * prompted password, and getpass(3) keeps only the first 128 characters: a
 * JWT came back truncated while the write reported success. The command-line
 * checks run everywhere. The TokenStore refusal runs on macOS with a stand-in
 * `security` first on PATH, so it cannot reach a real keychain. The real
 * round-trip needs the login keychain, so it runs only on macOS with
 * ML_DASH_KEYCHAIN_TEST=1, against a throwaway service that it deletes
 * afterwards. Each skips rather than passes elsewhere.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { macAddPasswordCommand, macKeychain, TokenStore } from "../src/auth/token-storage.js";

const fakeToken = (n: number): string => ("SYNTHETIC-FAKE-TOKEN." + "x".repeat(n)).slice(0, n);

describe("macAddPasswordCommand", () => {
  test("carries the value only as hex, on a single line", () => {
    const value = fakeToken(600);
    const line = macAddPasswordCommand("ml-dash", "ml-dash-token", value);
    assert.ok(!line.includes(value));
    assert.ok(line.endsWith(` -X ${Buffer.from(value).toString("hex")}\n`));
    assert.equal(line.indexOf("\n"), line.length - 1);
  });

  test("refuses what it cannot write safely", () => {
    assert.throws(() => macAddPasswordCommand("ml-dash", "a b", "v"), /unsafe/);
    assert.throws(() => macAddPasswordCommand("ml-dash", "ml-dash-token", ""), /empty/);
    assert.throws(() => macAddPasswordCommand("ml-dash", "ml-dash-token", fakeToken(2500)), /too long/);
  });
});

describe("TokenStore.store on macOS", { skip: process.platform === "darwin" ? false : "macOS only" }, () => {
  test("an over-long token fails before any keychain call and writes no file", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "ml-dash-keychain-test-"));
    const bin = path.join(tmp, "bin");
    const calls = path.join(tmp, "security-calls");
    const configDir = path.join(tmp, "config");
    const saved = { PATH: process.env.PATH, ML_DASH_NO_KEYCHAIN: process.env.ML_DASH_NO_KEYCHAIN };
    try {
      // A stand-in that records any call and fails, found before /usr/bin/security.
      mkdirSync(bin);
      writeFileSync(path.join(bin, "security"), `#!/bin/sh\necho called >> '${calls}'\nexit 1\n`);
      chmodSync(path.join(bin, "security"), 0o755);
      process.env.PATH = `${bin}:${saved.PATH}`;
      delete process.env.ML_DASH_NO_KEYCHAIN;

      assert.throws(() => new TokenStore(configDir).store(fakeToken(2500)), /too long/);
      assert.ok(!existsSync(calls), "security must not be called");
      assert.ok(!existsSync(configDir) || readdirSync(configDir).length === 0, "no fallback file");
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.ML_DASH_NO_KEYCHAIN !== undefined) process.env.ML_DASH_NO_KEYCHAIN = saved.ML_DASH_NO_KEYCHAIN;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

const liveKeychain = process.platform === "darwin" && process.env.ML_DASH_KEYCHAIN_TEST === "1";

describe("macKeychain round-trip", { skip: liveKeychain ? false : "set ML_DASH_KEYCHAIN_TEST=1 on macOS" }, () => {
  test("a token longer than 128 characters reads back exactly", () => {
    const kc = macKeychain(`ml-dash-test-${randomBytes(6).toString("hex")}`);
    const account = "synthetic-fake-token";
    assert.equal(kc.load(account), null, "throwaway item must not exist yet");
    try {
      const value = fakeToken(600);
      kc.store(account, value);
      assert.equal(kc.load(account), value);
    } finally {
      kc.delete(account);
      assert.equal(kc.load(account), null);
    }
  });
});
