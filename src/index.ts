#!/usr/bin/env node
/**
 * ml-dash CLI entry point.
 *
 * Commands are dispatched by name and their modules are imported lazily, so
 * `ml-dash version` does not pay for the GraphQL client or the QR encoder.
 */
import { ParseError, parseArgs, renderCommandHelp, renderRootHelp, usageError, type CommandSpec } from "./cli/parser.js";
import { red, yellow } from "./util/ansi.js";

interface CommandModule {
  spec: CommandSpec;
  run: (args: Record<string, string | boolean | undefined>) => number | Promise<number>;
}

const loaders: Record<string, () => Promise<CommandModule>> = {
  version: () => import("./commands/version.js") as Promise<CommandModule>,
  login: () => import("./commands/login.js") as Promise<CommandModule>,
  logout: () => import("./commands/logout.js") as Promise<CommandModule>,
  profile: () => import("./commands/profile.js") as Promise<CommandModule>,
  api: () => import("./commands/api.js") as Promise<CommandModule>,
  create: () => import("./commands/create.js") as Promise<CommandModule>,
  remove: () => import("./commands/remove.js") as Promise<CommandModule>,
  list: () => import("./commands/list.js") as Promise<CommandModule>,
  upload: () => import("./commands/upload.js") as Promise<CommandModule>,
  download: () => import("./commands/download.js") as Promise<CommandModule>,
};

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    const specs = await Promise.all(Object.values(loaders).map(async (l) => (await l()).spec));
    console.log(renderRootHelp(specs, Object.keys(loaders)));
    return 0;
  }
  if (command === "--version" || command === "-V") {
    return (await loaders.version()).run({});
  }

  const loader = loaders[command];
  if (!loader) {
    console.error(`${red("error:")} unknown command '${command}'`);
    console.error(`\nAvailable commands: ${Object.keys(loaders).join(", ")}`);
    return 2;
  }

  const mod = await loader();
  let args: Record<string, string | boolean | undefined>;
  try {
    args = parseArgs(mod.spec, rest);
  } catch (e) {
    if (e instanceof ParseError) {
      console.error(usageError(command, e.message));
      return 2;
    }
    throw e;
  }

  if (args.help) {
    console.log(renderCommandHelp(mod.spec));
    return 0;
  }

  return mod.run(args);
}

const isEntryPoint =
  // `import.meta.main` is set by Bun (including a compiled binary); Node needs
  // the argv comparison, and the npm shim imports this module rather than
  // running it directly, so neither check alone covers both channels.
  (import.meta as { main?: boolean }).main === true ||
  process.argv[1] === undefined ||
  /ml-dash(\.js)?$|index\.ts$|index\.js$/.test(process.argv[1]);

if (isEntryPoint) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`${red("✗ Unexpected error:")} ${e instanceof Error ? e.message : String(e)}`);
      if (process.env.ML_DASH_DEBUG === "1" && e instanceof Error) console.error(yellow(e.stack ?? ""));
      process.exitCode = 1;
    });
}
