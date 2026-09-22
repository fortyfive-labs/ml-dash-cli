/**
 * Fernet (symmetric encryption) over Node's crypto.
 *
 * The Python CLI stored fallback tokens with `cryptography.fernet.Fernet` in
 * ~/.dash/tokens.encrypted, keyed by ~/.dash/encryption.key. Reusing those
 * credentials means reproducing the wire format exactly, so this implements
 * the published spec rather than "some AES":
 *
 *   token = base64url( 0x80 ‖ timestamp(8, big-endian) ‖ IV(16)
 *                      ‖ AES-128-CBC(PKCS7(plaintext)) ‖ HMAC-SHA256(32) )
 *
 * The key is base64url of 32 bytes: the first 16 are the signing key, the last
 * 16 the encryption key. The HMAC covers everything before it.
 *
 * Nothing here is verified by construction — a plausible-looking but wrong
 * implementation still produces tokens that decrypt fine against itself. It is
 * checked instead against a fixture that Python's own Fernet produced; see
 * test/fernet-interop.test.ts.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 0x80;

const b64urlDecode = (s: string): Buffer => Buffer.from(s, "base64url");
/**
 * Fernet's base64 is padded. Node's "base64url" encoding strips the `=`, and
 * Python's `base64.urlsafe_b64decode` — which `cryptography.fernet` calls on
 * both the key and the token — raises on a stripped one. Unpadded output would
 * therefore round-trip perfectly here and be unreadable by the Python CLI, so
 * the padding is restored on the way out.
 */
const b64urlEncode = (b: Buffer): string => {
  const s = b.toString("base64url");
  return s + "=".repeat((4 - (s.length % 4)) % 4);
};

export class InvalidFernetToken extends Error {}

export interface FernetKey {
  signingKey: Buffer;
  encryptionKey: Buffer;
}

export function parseKey(key: string | Buffer): FernetKey {
  const raw = typeof key === "string" ? b64urlDecode(key.trim()) : key;
  if (raw.length !== 32) {
    throw new InvalidFernetToken(
      `Fernet key must decode to 32 bytes, got ${raw.length}. ` +
        "~/.dash/encryption.key is not a Fernet key.",
    );
  }
  return { signingKey: raw.subarray(0, 16), encryptionKey: raw.subarray(16, 32) };
}

/**
 * A new key, in the exact text form Python's `Fernet.generate_key()` emits:
 * url-safe base64 *with* padding. `base64.urlsafe_b64decode` rejects a
 * stripped `=`, so an unpadded key would be written fine here and then be
 * unreadable by the Python CLI sharing the same ~/.dash directory.
 */
export function generateKey(): string {
  return b64urlEncode(randomBytes(32));
}

export function encrypt(key: string | Buffer, plaintext: Buffer, opts: { iv?: Buffer; timestamp?: number } = {}): string {
  const { signingKey, encryptionKey } = parseKey(key);
  const iv = opts.iv ?? randomBytes(16);
  if (iv.length !== 16) throw new InvalidFernetToken("IV must be 16 bytes");

  const ts = Buffer.alloc(8);
  ts.writeBigUInt64BE(BigInt(opts.timestamp ?? Math.floor(Date.now() / 1000)));

  const cipher = createCipheriv("aes-128-cbc", encryptionKey, iv);
  // Node applies PKCS#7 padding by default, which is what Fernet specifies.
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const body = Buffer.concat([Buffer.from([VERSION]), ts, iv, ciphertext]);
  const hmac = createHmac("sha256", signingKey).update(body).digest();
  return b64urlEncode(Buffer.concat([body, hmac]));
}

export function decrypt(key: string | Buffer, token: string): Buffer {
  const { signingKey, encryptionKey } = parseKey(key);
  const raw = b64urlDecode(token.trim());

  // 1 version + 8 timestamp + 16 IV + at least one 16-byte block + 32 HMAC.
  if (raw.length < 73) throw new InvalidFernetToken("Fernet token is too short");
  if (raw[0] !== VERSION) {
    throw new InvalidFernetToken(`Unsupported Fernet version byte 0x${raw[0].toString(16)}`);
  }

  const body = raw.subarray(0, raw.length - 32);
  const mac = raw.subarray(raw.length - 32);
  const expected = createHmac("sha256", signingKey).update(body).digest();
  // Reject before decrypting: a wrong key must fail as a signature error, not
  // as a padding error, which is the whole point of Fernet's encrypt-then-MAC.
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new InvalidFernetToken("Fernet signature does not verify — wrong key or corrupt token");
  }

  const iv = body.subarray(9, 25);
  const ciphertext = body.subarray(25);
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new InvalidFernetToken("Fernet ciphertext is not a whole number of AES blocks");
  }
  const decipher = createDecipheriv("aes-128-cbc", encryptionKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Seconds-since-epoch the token records. Present for parity; unused by the CLI. */
export function tokenTimestamp(token: string): number {
  const raw = b64urlDecode(token.trim());
  if (raw.length < 9) throw new InvalidFernetToken("Fernet token is too short");
  return Number(raw.readBigUInt64BE(1));
}
