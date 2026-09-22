/**
 * OAuth 2.0 device authorization against vuer-auth, then token exchange with
 * the ml-dash server.
 *
 * This is a variant of RFC 8628, not the RFC itself: the poll request carries
 * `client_id` + `device_secret_hash` and no `device_code`. Sending a standard
 * poll body instead gets `authorization_pending` forever.
 */
import { hashDeviceSecret } from "./device-secret.js";

export const VUER_AUTH_URL = "https://auth.vuer.ai";
export const CLIENT_ID = "ml-dash-client";
export const DEFAULT_SCOPE = "openid profile email";

export interface DeviceFlowResponse {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export class DeviceCodeExpiredError extends Error {}
export class AuthorizationDeniedError extends Error {}
export class TokenExchangeError extends Error {}
export class AuthorizationTimeoutError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DeviceFlowClient {
  constructor(
    private readonly deviceSecret: string,
    private readonly dashUrl: string,
    private readonly authUrl: string = VUER_AUTH_URL,
  ) {
    this.dashUrl = dashUrl.replace(/\/+$/, "");
    this.authUrl = authUrl.replace(/\/+$/, "");
  }

  async startDeviceFlow(scope: string = DEFAULT_SCOPE): Promise<DeviceFlowResponse> {
    const res = await fetch(`${this.authUrl}/api/device/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        scope,
        device_secret_hash: hashDeviceSecret(this.deviceSecret),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Device flow start failed: ${res.status} ${await res.text()}`);
    const data: any = await res.json();
    const uri: string = data.verification_uri;
    const userCode: string = data.user_code;
    return {
      userCode,
      deviceCode: data.device_code ?? "",
      verificationUri: uri,
      verificationUriComplete:
        data.verification_uri_complete ?? `${uri}?code=${userCode.replace(/-/g, "")}`,
      expiresIn: data.expires_in ?? 600,
      interval: data.interval ?? 5,
    };
  }

  /** Poll until authorized. 120 attempts at 5 s is the Python CLI's 10-minute budget. */
  async pollForToken(
    maxAttempts = 120,
    onProgress?: (elapsedSeconds: number) => void,
  ): Promise<string> {
    const hash = hashDeviceSecret(this.deviceSecret);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      onProgress?.(attempt * 5);
      let res: Response;
      try {
        res = await fetch(`${this.authUrl}/api/device/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: CLIENT_ID, device_secret_hash: hash }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // Transient network trouble mid-flow should not end the login.
        await sleep(5_000);
        continue;
      }

      if (res.status === 200) return ((await res.json()) as any).access_token;

      let error: string | undefined;
      try {
        error = ((await res.json()) as any).error;
      } catch {
        error = undefined;
      }

      if (error === "authorization_pending") {
        await sleep(5_000);
        continue;
      }
      if (error === "slow_down") {
        await sleep(10_000);
        continue;
      }
      if (error === "expired_token") {
        throw new DeviceCodeExpiredError("Device code expired. Please run 'ml-dash login' again.");
      }
      if (error === "access_denied") {
        throw new AuthorizationDeniedError("User denied authorization request.");
      }
      throw new TokenExchangeError(`Device flow error: ${error ?? res.status}`);
    }

    throw new AuthorizationTimeoutError(
      "Authorization timed out after 10 minutes. Please run 'ml-dash login' again.",
    );
  }

  /** Trade the short-lived vuer-auth JWT for a permanent ml-dash token. */
  async exchangeToken(vuerAuthToken: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.dashUrl}/api/auth/exchange`, {
        method: "POST",
        headers: { Authorization: `Bearer ${vuerAuthToken}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new TokenExchangeError(`Network error during token exchange: ${e}`);
    }

    if (res.status === 401) {
      throw new TokenExchangeError("Vuer-auth token invalid or expired. Please try logging in again.");
    }
    if (res.status === 404) {
      throw new TokenExchangeError(
        "Token exchange endpoint not found. Please ensure ml-dash server is up to date.",
      );
    }
    if (!res.ok) {
      throw new TokenExchangeError(`Token exchange failed: ${res.status} ${await res.text()}`);
    }

    const token = ((await res.json()) as any).ml_dash_token;
    if (!token) throw new TokenExchangeError("Server response missing ml_dash_token field");
    return token;
  }
}
