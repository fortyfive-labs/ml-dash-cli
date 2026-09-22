/**
 * Where the ml-dash token lives, and how this CLI reaches credentials the
 * Python CLI wrote.
 *
 * The Python CLI tried, in order: the OS keyring (service "ml-dash", account
 * "ml-dash-token"), then a Fernet-encrypted file, then plaintext. This keeps
 * the same order and the same on-disk formats, so an existing login keeps
 * working rather than silently appearing logged-out.
 *
 * A compiled single-file binary has no Python `keyring` to call, so the OS
 * keychain is reached through the platform's own tool: `security` on macOS,
 * `secret-tool` on Linux. Both are read WITHOUT putting the secret on a
 * command line — reads print to stdout, and the macOS write feeds the value
 * over stdin — so the token never appears in `ps` output.
 *
 * Windows Credential Manager has no comparable tool that ships with the OS.
 * Rather than pretend, `unreadableKeychainReason` reports it and the caller
 * tells the user to run `ml-dash login` again. A missing credential must never
 * read as an empty success.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { decrypt, encrypt, generateKey } from "./fernet.js";

export const SERVICE_NAME = "ml-dash";
export const TOKEN_KEY = "ml-dash-token";

export type StorageSource = "keychain" | "encrypted-file" | "plaintext-file";

export interface LoadResult {
  token: string | null;
  source: StorageSource | null;
  /** Set when a credential probably exists but this build cannot read it. */
  unreadableReason?: string;
}

const has = (cmd: string): boolean =>
  spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;

// ── OS keychain ──────────────────────────────────────────────────────────────

interface Keychain {
  load(key: string): string | null;
  store(key: string, value: string): void;
  delete(key: string): void;
}

const macKeychain: Keychain = {
  load(key) {
    const r = spawnSync("security", ["find-generic-password", "-s", SERVICE_NAME, "-a", key, "-w"], {
      encoding: "utf8",
    });
    // 44 is `security`'s "item not found". Anything else non-zero is a real
    // failure (a denied keychain prompt, a locked keychain) and must not be
    // flattened into "no token".
    if (r.status === 0) return r.stdout.replace(/\n$/, "");
    if (r.status === 44) return null;
    throw new Error(`macOS keychain read failed (exit ${r.status}): ${(r.stderr || "").trim()}`);
  },
  store(key, value) {
    // `-w` with no value makes `security` read the password from stdin twice,
    // which keeps it out of argv.
    const r = spawnSync("security", ["add-generic-password", "-U", "-s", SERVICE_NAME, "-a", key, "-w"], {
      input: `${value}\n${value}\n`,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`macOS keychain write failed: ${(r.stderr || "").trim()}`);
  },
  delete(key) {
    spawnSync("security", ["delete-generic-password", "-s", SERVICE_NAME, "-a", key], { stdio: "ignore" });
  },
};

const secretToolKeychain: Keychain = {
  load(key) {
    const r = spawnSync("secret-tool", ["lookup", "service", SERVICE_NAME, "username", key], {
      encoding: "utf8",
    });
    if (r.status === 0 && r.stdout !== "") return r.stdout.replace(/\n$/, "");
    return null;
  },
  store(key, value) {
    const r = spawnSync(
      "secret-tool",
      ["store", "--label", `${SERVICE_NAME} ${key}`, "service", SERVICE_NAME, "username", key],
      { input: value, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`secret-tool write failed: ${(r.stderr || "").trim()}`);
  },
  delete(key) {
    spawnSync("secret-tool", ["clear", "service", SERVICE_NAME, "username", key], { stdio: "ignore" });
  },
};

function keychain(): Keychain | null {
  if (process.env.ML_DASH_NO_KEYCHAIN === "1") return null;
  if (process.platform === "darwin" && has("security")) return macKeychain;
  if (process.platform === "linux" && has("secret-tool")) return secretToolKeychain;
  return null;
}

/**
 * Why the keychain could not be consulted, when that is worth telling the user.
 * Returns null when there is nothing unusual to report.
 */
export function unreadableKeychainReason(): string | null {
  if (process.env.ML_DASH_NO_KEYCHAIN === "1") return null;
  if (process.platform === "win32") {
    return (
      "Windows Credential Manager cannot be read by this build. If you previously " +
      "logged in with the Python ml-dash CLI, that token is not reachable here."
    );
  }
  if (process.platform === "linux" && !has("secret-tool")) {
    return (
      "`secret-tool` is not installed, so the GNOME keyring cannot be read. " +
      "If you previously logged in with the Python ml-dash CLI, that token is not reachable here."
    );
  }
  if (process.platform === "darwin" && !has("security")) {
    return "`security` is not on PATH, so the macOS Keychain cannot be read.";
  }
  return null;
}

// ── file backends ────────────────────────────────────────────────────────────

export class TokenStore {
  readonly configDir: string;
  private readonly encFile: string;
  private readonly keyFile: string;
  private readonly plainFile: string;

  constructor(configDir?: string) {
    this.configDir = configDir ?? process.env.ML_DASH_CONFIG_DIR ?? path.join(homedir(), ".dash");
    this.encFile = path.join(this.configDir, "tokens.encrypted");
    this.keyFile = path.join(this.configDir, "encryption.key");
    this.plainFile = path.join(this.configDir, "tokens.json");
  }

  private readEncrypted(): Record<string, string> {
    if (!existsSync(this.encFile) || !existsSync(this.keyFile)) return {};
    const key = readFileSync(this.keyFile, "utf8");
    return JSON.parse(decrypt(key, readFileSync(this.encFile, "utf8")).toString("utf8"));
  }

  private writeEncrypted(all: Record<string, string>): void {
    mkdirSync(this.configDir, { recursive: true });
    if (!existsSync(this.keyFile)) {
      writeFileSync(this.keyFile, generateKey());
      chmodSync(this.keyFile, 0o600);
    }
    writeFileSync(
      this.encFile,
      // The key file stores base64 text (Python's format), not raw bytes.
      encrypt(readFileSync(this.keyFile, "utf8"), Buffer.from(JSON.stringify(all), "utf8")),
    );
    chmodSync(this.encFile, 0o600);
  }

  private readPlain(): Record<string, string> {
    if (!existsSync(this.plainFile)) return {};
    try {
      return JSON.parse(readFileSync(this.plainFile, "utf8"));
    } catch {
      return {};
    }
  }

  /**
   * Resolve a token, reporting which backend answered. Keychain first, so a
   * Python-era login is found before any file this CLI wrote.
   */
  load(key: string = TOKEN_KEY): LoadResult {
    const kc = keychain();
    if (kc) {
      const v = kc.load(key);
      if (v) return { token: v, source: "keychain" };
    }

    if (existsSync(this.encFile)) {
      // A decrypt failure here is load-bearing: the file exists, so the user
      // does have a stored credential, and swallowing the error would present
      // a corrupt keyfile as "never logged in".
      const v = this.readEncrypted()[key];
      if (v) return { token: v, source: "encrypted-file" };
    }

    const p = this.readPlain()[key];
    if (p) return { token: p, source: "plaintext-file" };

    return { token: null, source: null, unreadableReason: unreadableKeychainReason() ?? undefined };
  }

  /** Write to the keychain when one is reachable, otherwise the encrypted file. */
  store(value: string, key: string = TOKEN_KEY): StorageSource {
    const kc = keychain();
    if (kc) {
      try {
        kc.store(key, value);
        return "keychain";
      } catch {
        // Fall through — an unavailable keychain should not fail a login.
      }
    }
    const all = existsSync(this.encFile) ? this.readEncrypted() : {};
    all[key] = value;
    this.writeEncrypted(all);
    return "encrypted-file";
  }

  /** Clear every backend: logging out of one but not the others is not a logout. */
  delete(key: string = TOKEN_KEY): void {
    const kc = keychain();
    if (kc) {
      try {
        kc.delete(key);
      } catch {
        /* already absent */
      }
    }
    if (existsSync(this.encFile)) {
      try {
        const all = this.readEncrypted();
        if (key in all) {
          delete all[key];
          this.writeEncrypted(all);
        }
      } catch {
        // Undecryptable file: remove it rather than leave a credential behind.
        unlinkSync(this.encFile);
      }
    }
    if (existsSync(this.plainFile)) {
      const all = this.readPlain();
      if (key in all) {
        delete all[key];
        writeFileSync(this.plainFile, JSON.stringify(all, null, 2));
        chmodSync(this.plainFile, 0o600);
      }
    }
  }
}
