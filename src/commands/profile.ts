/**
 * `ml-dash profile` — who am I, according to the token and to the server.
 *
 * The token is a JWT, so the identity it carries can be shown without a
 * network round trip (`--cached`). By default the server is asked instead,
 * because a username can change after the token was issued; if that call
 * fails the token's own claims are shown with a warning rather than an error,
 * matching the Python CLI.
 *
 * One deliberate divergence: the Python CLI embedded rich markup
 * (`[red]Token expired[/red]`) inside `--json` output. Here `--json` carries
 * plain text, so the output can be consumed by a script; the styled form is
 * used only in the human table.
 */
import { userInfo } from "node:os";
import { decodeJwtPayload } from "../auth/jwt.js";
import { TokenStore } from "../auth/token-storage.js";
import { RemoteClient } from "../client.js";
import { Config, DEFAULT_API_URL } from "../config.js";
import type { CommandSpec, ParsedArgs } from "../cli/parser.js";
import { bold, cyan, dim, green, renderPanel, yellow } from "../util/ansi.js";

export const spec: CommandSpec = {
  name: "profile",
  help: "Show current user profile",
  description: "Display the current authenticated user profile and configuration.",
  options: [
    { flags: ["--dash-url", "--api-url"], dest: "dash_url", metavar: "URL", help: "ML-Dash server URL (default: from config)" },
    { flags: ["--json"], dest: "json", boolean: true, help: "Output as JSON" },
    { flags: ["--cached"], dest: "cached", boolean: true, help: "Use cached token data (default: fetch fresh from server)" },
  ],
};

/** (expired, human status) for a JWT `exp` claim. */
export function checkTokenExpiration(payload: Record<string, any>): [boolean, string | null] {
  const exp = payload.exp;
  if (!exp) return [false, null];
  const timeLeft = Number(exp) - Math.floor(Date.now() / 1000);
  if (timeLeft < 0) return [true, "Token expired"];
  if (timeLeft < 86400) return [false, `Token expires in ${Math.floor(timeLeft / 3600)} hours`];
  return [false, `Expires in ${Math.floor(timeLeft / 86400)} days`];
}

async function fetchFreshProfile(remoteUrl: string, token: string): Promise<Record<string, any> | null> {
  try {
    const user = await new RemoteClient(remoteUrl, undefined, token).getCurrentUser();
    if (!user) return null;
    return {
      sub: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      given_name: user.given_name,
      family_name: user.family_name,
    };
  } catch {
    return null;
  }
}

export async function run(args: ParsedArgs): Promise<number> {
  const config = new Config();
  const store = new TokenStore(config.configDir);
  const loaded = store.load();
  const token = loaded.token;
  const remoteUrl = (typeof args.dash_url === "string" ? args.dash_url : undefined) || config.remoteUrl;

  const info: Record<string, any> = {
    authenticated: false,
    remote_url: remoteUrl,
    local_user: safeUsername(),
  };
  if (!token && loaded.unreadableReason) info.warning = loaded.unreadableReason;

  if (token) {
    info.authenticated = true;
    const payload = decodeJwtPayload(token);
    const [expired, expiryMessage] = checkTokenExpiration(payload);

    if (expired) {
      info.authenticated = false;
      info.error = "Token expired. Please run 'ml-dash login' to re-authenticate.";
    } else {
      if (args.cached) {
        info.user = payload;
        info.source = "token";
      } else {
        const fresh = await fetchFreshProfile(remoteUrl, token);
        if (fresh) {
          info.user = fresh;
          info.source = "server";
        } else {
          info.user = payload;
          info.source = "token";
          info.warning = "Could not fetch fresh profile from server, using cached token data";
        }
      }
      if (expiryMessage) info.token_status = expiryMessage;
    }
  }

  if (args.json) {
    console.log(JSON.stringify(info, null, 2));
    return 0;
  }

  if (!info.authenticated) {
    console.log(
      renderPanel(
        `${cyan(bold("OS Username:"))}  ${info.local_user}\n\n` +
          `${yellow(info.error ?? "Not authenticated")}\n\n` +
          `Run ${cyan("ml-dash login")} to authenticate.`,
        { title: bold("ML-Dash Info") },
      ),
    );
    return 0;
  }

  const user = info.user ?? {};
  const rows: [string, string][] = [];
  rows.push(["Username", user.username ?? "Unavailable"]);
  if (user.sub) rows.push(["User ID", String(user.sub)]);
  rows.push(["Name", user.name ?? "Unknown"]);
  if (user.email) rows.push(["Email", user.email]);
  rows.push(["Remote", info.remote_url || DEFAULT_API_URL]);
  if (info.token_status) rows.push(["Token Status", info.token_status]);
  rows.push(["Data Source", info.source === "server" ? green("Server (Fresh)") : yellow("Token (Cached)")]);

  const keyWidth = Math.max(...rows.map(([k]) => k.length));
  let body = rows.map(([k, v]) => `${cyan(bold(k.padEnd(keyWidth)))}  ${v}`).join("\n");
  if (info.warning) body += `\n\n${yellow(`⚠ ${info.warning}`)}`;
  if (info.source === "server") {
    body += `\n${dim("Tip: Use --cached to use cached token data (faster but may be outdated)")}`;
  }

  console.log(renderPanel(body, { title: green(bold("✓ Authenticated")) }));
  return 0;
}

/** `os.userInfo()` throws on hosts where the uid has no passwd entry. */
function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "unknown";
  }
}
