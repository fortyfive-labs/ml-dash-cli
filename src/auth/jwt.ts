/** Decode a JWT payload without verifying it — for display only, as the Python CLI did. */
export function decodeJwtPayload(token: string): Record<string, any> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return {};
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}
