import type { CommandSpec } from "./parser.js";
import { managementLoaders } from "../managed/commands.js";

interface CommandModule {
  spec: CommandSpec;
  run: (args: Record<string, string | boolean | undefined>) => number | Promise<number>;
}

export const commandLoaders: Record<string, () => Promise<CommandModule>> = {
  ...managementLoaders,
  schema: () => import("../commands/schema.js") as Promise<CommandModule>,
  version: () => import("../commands/version.js") as Promise<CommandModule>,
  login: () => import("../commands/login.js") as Promise<CommandModule>,
  logout: () => import("../commands/logout.js") as Promise<CommandModule>,
  profile: () => import("../commands/profile.js") as Promise<CommandModule>,
  api: () => import("../commands/api.js") as Promise<CommandModule>,
  create: () => import("../commands/create.js") as Promise<CommandModule>,
  remove: () => import("../commands/remove.js") as Promise<CommandModule>,
  list: () => import("../commands/list.js") as Promise<CommandModule>,
  upload: () => import("../commands/upload.js") as Promise<CommandModule>,
  download: () => import("../commands/download.js") as Promise<CommandModule>,
  update: () => import("../commands/update.js") as Promise<CommandModule>,
};

