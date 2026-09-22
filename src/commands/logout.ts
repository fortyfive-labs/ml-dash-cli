/** Clear the stored token from every backend it might live in. */
import { TokenStore } from "../auth/token-storage.js";
import { Config } from "../config.js";
import type { CommandSpec } from "../cli/parser.js";
import { green, red } from "../util/ansi.js";

export const spec: CommandSpec = {
  name: "logout",
  help: "Clear stored authentication token",
  description: "Logout from ml-dash by clearing the stored authentication token.",
  options: [],
};

export function run(): number {
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
