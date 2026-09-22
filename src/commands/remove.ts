/**
 * `ml-dash remove` — delete a project and everything under it.
 *
 * The confirmation is a typed project name, not a y/n: the action deletes
 * every experiment, metric, log and file in the project and cannot be undone,
 * so a mistyped `-p` should not be one keystroke away from destroying the
 * wrong project. `-y` skips it for scripts.
 *
 * A project that does not exist exits 0 — "make sure this is gone" has already
 * succeeded — while a permission failure exits 1.
 */
import { createInterface } from "node:readline/promises";
import { HttpError } from "../client.js";
import { makeClient, notAuthenticatedMessage, resolveContext } from "../cli/context.js";
import type { CommandSpec, ParsedArgs } from "../cli/parser.js";
import { splitProjectArg } from "./create.js";
import { bold, dim, green, red, yellow } from "../util/ansi.js";

export const spec: CommandSpec = {
  name: "remove",
  help: "Delete a project",
  description: `Delete a project from ml-dash.

WARNING: This will delete the project and all its experiments, metrics, files, and logs.
This action cannot be undone.

Examples:
  ml-dash remove -p my-project
  ml-dash remove -p geyang/old-project
  ml-dash remove -p my-project -y`,
  options: [
    { flags: ["-p", "--project"], dest: "project", required: true, metavar: "PROJECT", help: "Project name or namespace/project (e.g. 'my-project' or 'tom/my-project')" },
    { flags: ["-y", "--yes"], dest: "yes", boolean: true, help: "Skip confirmation prompt" },
    { flags: ["--dash-url", "--api-url"], dest: "dash_url", metavar: "URL", help: "ML-Dash server URL (default: https://api.dash.ml)" },
  ],
};

async function promptForName(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question("Type the project name to confirm deletion: ")).trim();
  } finally {
    rl.close();
  }
}

export async function run(args: ParsedArgs): Promise<number> {
  const ctx = resolveContext(args);
  const raw = String(args.project);
  const split = splitProjectArg(raw);
  if (!split) {
    console.error(
      `${red("Error:")} Project can have at most 2 parts (namespace/project).\n` +
        `Got: ${raw}\n\nExamples:\n  ml-dash remove -p my-project\n  ml-dash remove -p geyang/old-project`,
    );
    return 1;
  }
  if (!ctx.apiKey) {
    console.error(`${red("Error:")} ${notAuthenticatedMessage(ctx)}`);
    return 1;
  }

  const client = makeClient(ctx, split.namespace);

  try {
    const namespace = await client.namespace();
    if (!namespace) {
      console.error(`${red("Error:")} Could not determine namespace. Please login first.`);
      return 1;
    }
    const fullPath = `${namespace}/${split.project}`;

    const projectId = await client.getProjectId(split.project);
    if (!projectId) {
      console.log(`${yellow("⚠")} Project '${bold(fullPath)}' not found.`);
      return 0;
    }

    if (!args.yes) {
      // Without a terminal there is nobody to type the name, and defaulting to
      // "delete" would make a piped invocation destructive by accident.
      if (!process.stdin.isTTY) {
        console.error(
          `${red("Error:")} Refusing to delete '${fullPath}' without confirmation.\n` +
            "stdin is not a terminal — pass -y to confirm non-interactively.",
        );
        return 1;
      }
      console.log(
        `\n${red(bold("⚠ WARNING ⚠"))}\n\n` +
          `You are about to delete project: ${bold(fullPath)}\n` +
          "This will permanently delete:\n" +
          "  • All experiments in this project\n" +
          "  • All metrics and logs\n" +
          "  • All uploaded files\n\n" +
          `${red("This action CANNOT be undone.")}\n`,
      );
      const answer = await promptForName();
      if (answer !== split.project) {
        console.log(`\n${yellow("Deletion cancelled.")}`);
        return 0;
      }
    }

    console.log(`\n${dim(`Deleting project '${fullPath}'...`)}`);
    const result = await client.deleteProject(split.project);

    console.log(
      `${green("✓")} Project '${bold(split.project)}' deleted from namespace '${bold(namespace)}'`,
    );
    if (result?.deleted != null) console.log(`  Deleted nodes: ${result.deleted}`);
    if (result?.experiments != null) console.log(`  Deleted experiments: ${result.experiments}`);
    return 0;
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 404) {
        console.log(`${yellow("⚠")} Project '${bold(split.project)}' not found.`);
        return 0;
      }
      if (e.status === 403) {
        console.error(`${red("Error:")} Permission denied.`);
        return 1;
      }
    }
    console.error(`${red("Error deleting project:")} ${(e as Error).message}`);
    return 1;
  }
}
