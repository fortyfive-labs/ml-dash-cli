/**
 * `ml-dash login` — OAuth 2.0 device authorization against vuer-auth, then a
 * token exchange with the ml-dash server.
 *
 * The user never types a password here: the CLI shows a short code (and a QR
 * for a phone), the browser does the authorization, and polling picks up a
 * short-lived vuer-auth JWT which is immediately traded for the long-lived
 * ml-dash token that actually gets stored.
 *
 * The stored token is printed nowhere — only where it was stored — so a shared
 * terminal or a pasted transcript never leaks a credential.
 */
import { spawn } from "node:child_process";
import {
  AuthorizationDeniedError,
  AuthorizationTimeoutError,
  DeviceFlowClient,
  TokenExchangeError,
  VUER_AUTH_URL,
  DeviceCodeExpiredError,
} from "../auth/device-flow.js";
import { getOrCreateDeviceSecret } from "../auth/device-secret.js";
import { TokenStore } from "../auth/token-storage.js";
import { Config, DEFAULT_API_URL } from "../config.js";
import type { CommandSpec, ParsedArgs } from "../cli/parser.js";
import { bold, blue, cyan, dim, green, red, renderPanel } from "../util/ansi.js";

export const spec: CommandSpec = {
  name: "login",
  help: "Authenticate with ml-dash using device authorization flow",
  description: `Login to ml-dash server using the OAuth2 device authorization flow.

After logging in, you can:
  • Upload/download experiments via CLI
  • View projects, experiments, and statistics at https://dash.ml
  • Create interactive plots and dashboards`,
  options: [
    { flags: ["--dash-url", "--api-url"], dest: "dash_url", metavar: "URL", help: "ML-Dash server URL (e.g., https://api.dash.ml)" },
    { flags: ["--auth-url"], dest: "auth_url", metavar: "URL", help: "OAuth authorization server URL (e.g., https://auth.vuer.ai)" },
    { flags: ["--no-browser"], dest: "no_browser", boolean: true, help: "Don't automatically open browser for authorization" },
  ],
};

/** Block-character QR, the shape the Python CLI drew. null when unavailable. */
async function qrCodeAscii(url: string): Promise<string | null> {
  try {
    const { create } = await import("qrcode");
    const { modules } = create(url, {});
    const size = modules.size;
    const lines: string[] = [];
    // A one-module quiet zone, matching `qrcode.QRCode(border=1)`.
    lines.push("  ".repeat(size + 2));
    for (let y = 0; y < size; y++) {
      let line = "  ";
      for (let x = 0; x < size; x++) line += modules.data[y * size + x] ? "██" : "  ";
      lines.push(line + "  ");
    }
    lines.push("  ".repeat(size + 2));
    return lines.join("\n");
  } catch {
    return null;
  }
}

function openBrowser(url: string): boolean {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function run(args: ParsedArgs): Promise<number> {
  const config = new Config();
  const remoteUrl = (typeof args.dash_url === "string" ? args.dash_url : undefined) || config.remoteUrl || DEFAULT_API_URL;
  const authUrl = (typeof args.auth_url === "string" ? args.auth_url : undefined) || config.authUrl || VUER_AUTH_URL;

  try {
    console.log(`${bold("Initializing device authorization...")}\n`);

    const deviceSecret = getOrCreateDeviceSecret(config);
    const client = new DeviceFlowClient(deviceSecret, remoteUrl, authUrl);
    const flow = await client.startDeviceFlow();

    let body =
      `${cyan(bold("1. Visit this URL:"))}\n\n   ${flow.verificationUri}\n\n` +
      `${cyan(bold("2. Enter this code:"))}\n\n   ${green(bold(flow.userCode))}\n`;
    const qr = await qrCodeAscii(flow.verificationUriComplete);
    if (qr) body += `\n${cyan(bold("Or scan QR code:"))}\n\n${qr}\n`;
    body += `\n${dim(`Code expires in ${Math.floor(flow.expiresIn / 60)} minutes`)}`;

    console.log(renderPanel(body, { title: blue(bold("DEVICE AUTHORIZATION REQUIRED")) }));
    console.log();

    if (!args.no_browser && openBrowser(flow.verificationUriComplete)) {
      console.log(`${dim("✓ Opened browser automatically")}\n`);
    }

    console.log(bold("Waiting for authorization..."));
    const vuerAuthToken = await client.pollForToken(120, (elapsed) => {
      if (process.stdout.isTTY) process.stdout.write(`\r${dim(`Waiting (${elapsed}s)`)}   `);
    });
    if (process.stdout.isTTY) process.stdout.write("\r\u001b[K");

    console.log(`${green("✓ Authorization successful!")}\n`);
    console.log(bold("Exchanging token with ml-dash server..."));

    const mlDashToken = await client.exchangeToken(vuerAuthToken);
    const where = new TokenStore(config.configDir).store(mlDashToken);

    console.log(`${green("✓ Token exchanged successfully!")}\n`);
    console.log(
      `${green(bold("✓ Logged in successfully!"))}\n\n` +
        `Your authentication token has been stored (${where}).\n\n` +
        `${cyan(bold("View your data online:"))}\n  https://dash.ml\n\n` +
        "Access your projects, experiments, statistics, and interactive plots.\n\n" +
        `${bold("CLI Commands:")}\n  ml-dash list\n  ml-dash profile`,
    );
    return 0;
  } catch (e) {
    if (e instanceof DeviceCodeExpiredError) {
      console.error(
        `\n${red("✗ Device code expired")}\n\nThe authorization code expired after 10 minutes.\n` +
          "Please run 'ml-dash login' again.",
      );
      return 1;
    }
    if (e instanceof AuthorizationDeniedError) {
      console.error(
        `\n${red("✗ Authorization denied")}\n\nYou declined the authorization request in your browser.\n\n` +
          "To try again:\n  ml-dash login",
      );
      return 1;
    }
    if (e instanceof AuthorizationTimeoutError) {
      console.error(`\n${red("✗ Authorization timed out")}\n\nNo response after 10 minutes.\n\nPlease run 'ml-dash login' again.`);
      return 1;
    }
    if (e instanceof TokenExchangeError) {
      console.error(`\n${red("✗ Token exchange failed:")} ${e.message}\n`);
      return 1;
    }
    console.error(`\n${red("✗ Unexpected error:")} ${(e as Error).message}`);
    return 1;
  }
}
