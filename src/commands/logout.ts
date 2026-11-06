/** Clear the stored token: the standalone ML-Dash login, or (`--backend native`) one shared DreamLake environment. */
import { homedir } from "node:os";
import path from "node:path";
import { TokenStore } from "../auth/token-storage.js";
import { Config } from "../config.js";
import type { CommandSpec, ParsedArgs } from "../cli/parser.js";
import { green, red, yellow } from "../util/ansi.js";

export const spec: CommandSpec = {
  name: "logout",
  help: "Clear stored authentication token",
  description:
    "Logout from ml-dash by clearing the stored authentication token.\n\n" +
    "With --backend native, log out of one shared DreamLake environment (default: the active one),\n" +
    "following the DreamLake shared login contract; the standalone ML-Dash login is not touched.",
  options: [
    { flags: ["--backend"], dest: "backend", metavar: "BACKEND", choices: ["standalone", "native"], help: "standalone (default): this ML-Dash login; native: a shared DreamLake environment" },
    { flags: ["--env"], dest: "env", metavar: "NAME", help: "DreamLake environment to log out of (native; default: the active one)" },
    { flags: ["--json"], dest: "json", boolean: true, help: "Output as JSON (native)" },
  ],
};

async function nativeLogout(args: ParsedArgs): Promise<number> {
  const { logout } = await import("../managed/shared-login.js");
  const dir = process.env.ML_DASH_MANAGED_CONFIG_DIR || path.join(homedir(), ".dreamlake");
  const result = logout(dir, typeof args.env === "string" ? args.env : undefined);
  const ok = result.status !== "unknown-env";
  if (args.json) console.log(JSON.stringify(ok ? { ok: true, data: result } : { ok: false, error: { code: "SHARED_LOGIN_UNKNOWN_ENV", message: `No saved environment '${result.env}'.`, saved: result.saved } }, null, 2));
  else if (result.status === "unknown-env") console.error(`${red("✗")} No saved environment '${result.env}'. Saved: ${result.saved.join(", ") || "(none)"}`);
  else if (result.status === "not-logged-in") console.log(yellow("No DreamLake login to clear."));
  else if (result.status === "orphan-cleared") console.log(green(`✓ Logged out of ${result.server ?? "the unsaved DreamLake connection"}.`));
  else console.log(green(`✓ Logged out of '${result.env}'.`) + (result.projection === "next" ? ` Active environment is now '${result.current}'.` : result.projection === "cleared" ? " No environments left." : " The active connection is a different environment and is unchanged."));
  return ok ? 0 : 1;
}

export async function run(args: ParsedArgs = {}): Promise<number> {
  if (args.backend === "native") return nativeLogout(args);
  if (args.env !== undefined || args.json) {
    console.error(`${red("✗")} --env and --json apply to --backend native.`);
    return 2;
  }
  try {
    new TokenStore(new Config().configDir).delete();
    console.log(
      green("✓ Logged out successfully!") +
        "\n\nYour authentication token has been cleared.\n\nTo log in again:\n  ml-dash login",
    );
    return 0;
  } catch (e) {
    console.error(`${red("✗ Storage error:")} ${(e as Error).message}`);
    return 1;
  }
}
