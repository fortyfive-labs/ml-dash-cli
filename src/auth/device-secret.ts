/**
 * Device identity for the authorization flow.
 *
 * vuer-auth's device endpoints identify this client by the SHA-256 of a
 * locally generated secret rather than by a server-issued device_code, so the
 * hash has to be computed the same way the Python CLI computed it or polling
 * never matches the pending authorization.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Config } from "../config.js";

/** 32 bytes of entropy, hex-encoded — the shape `secrets.token_hex(32)` produced. */
export const generateDeviceSecret = (): string => randomBytes(32).toString("hex");

export const hashDeviceSecret = (secret: string): string =>
  createHash("sha256").update(secret, "utf8").digest("hex");

export function getOrCreateDeviceSecret(config: Config): string {
  const existing = config.deviceSecret;
  if (existing) return existing;
  const secret = generateDeviceSecret();
  config.set("device_secret", secret);
  return secret;
}
