/**
 * `ml-dash create` — create a project.
 *
 * `-p` accepts either `project` or `namespace/project`; anything deeper is a
 * user error rather than a nested project, since projects do not nest.
 * An existing project reports success (exit 0): creating what is already
 * there is the outcome the caller asked for, and scripts that create-then-use
 * should not have to special-case the second run.
 */
import { HttpError } from "../client.js";
import { makeClient, notAuthenticatedMessage, resolveContext } from "../cli/context.js";
import type { CommandSpec, ParsedArgs } from "../cli/parser.js";
import { asId } from "../util/json.js";
import { bold, dim, green, red, yellow } from "../util/ansi.js";

export const spec: CommandSpec = {
  name: "create",
  help: "Create a new project",
  description: `Create a new project in ml-dash.

Examples:
  ml-dash create -p new-project
  ml-dash create -p geyang/new-project
  ml-dash create -p geyang/tutorials -d "ML tutorials and examples"`,
  options: [
    { flags: ["-p", "--project"], dest: "project", required: true, metavar: "PROJECT", help: "Project name or namespace/project (e.g. 'my-project' or 'tom/my-project')" },
    { flags: ["-d", "--description"], dest: "description", metavar: "TEXT", help: "Project description (optional)" },
    { flags: ["--dash-url", "--api-url"], dest: "dash_url", metavar: "URL", help: "ML-Dash server URL (default: https://api.dash.ml)" },
  ],
};

/** Split `-p` into (namespace, project). null namespace means "the caller's own". */
export function splitProjectArg(raw: string): { namespace?: string; project: string } | null {
  const parts = raw.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length > 2 || parts.some((p) => p === "")) return null;
  return parts.length === 1 ? { project: parts[0] } : { namespace: parts[0], project: parts[1] };
}

export async function run(args: ParsedArgs): Promise<number> {
  const ctx = resolveContext(args);
  const raw = String(args.project);
  const split = splitProjectArg(raw);
  if (!split) {
    console.error(
      `${red("Error:")} Project can have at most 2 parts (namespace/project).\n` +
        `Got: ${raw}\n\nExamples:\n  ml-dash create -p new-project\n  ml-dash create -p geyang/new-project`,
    );
    return 1;
  }
  if (!ctx.apiKey) {
    console.error(`${red("Error:")} ${notAuthenticatedMessage(ctx)}`);
    return 1;
  }

  const client = makeClient(ctx, split.namespace);
  const description = typeof args.description === "string" ? args.description : undefined;

  let namespace = split.namespace;
  try {
    namespace = await client.namespace();
    if (!namespace) {
      console.error(`${red("Error:")} Could not determine namespace. Please login first.`);
      return 1;
    }
    console.log(dim(`Creating project '${split.project}' in namespace '${namespace}'`));

    const result = await client.createProject(split.project, description);
    const project = result?.project ?? result ?? {};
    const projectSlug = project.slug ?? split.project;
    const projectId = asId(project.id);

    console.log(`${green("✓")} Project created successfully!`);
    console.log(`  Name: ${bold(projectSlug)}`);
    console.log(`  Namespace: ${bold(namespace)}`);
    if (projectId) console.log(`  ID: ${projectId}`);
    if (description) console.log(`  Description: ${description}`);
    console.log(`\n  View at: https://dash.ml/@${namespace}/${projectSlug}`);
    return 0;
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) {
      console.log(
        `${yellow("⚠")} Project '${bold(split.project)}' already exists in namespace ` +
          `'${bold(namespace ?? "(current)")}'`,
      );
      return 0;
    }
    console.error(`${red("Error creating project:")} ${(e as Error).message}`);
    return 1;
  }
}
