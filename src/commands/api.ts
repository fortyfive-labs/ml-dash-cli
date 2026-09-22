/**
 * `ml-dash api` — raw GraphQL against the server.
 *
 * Two conveniences from the Python CLI are load-bearing and reproduced exactly:
 * a bare selection set is wrapped in `{ … }` (or `mutation { … }`), and single
 * quotes are rewritten to double quotes so a query survives shell quoting.
 */
import { makeClient, notAuthenticatedMessage, resolveContext } from "../cli/context.js";
import type { CommandSpec, ParsedArgs } from "../cli/parser.js";
import { red } from "../util/ansi.js";

export const spec: CommandSpec = {
  name: "api",
  help: "Send GraphQL queries to ml-dash server",
  description: `Send GraphQL queries to the ml-dash server.

Examples:
  ml-dash api --query "me { username name email }"
  ml-dash api --query "user(title: 'hello') { id title }"
  ml-dash api --query "me { username }" --jq ".me.username"
  ml-dash api --mutation "updateUser(username: 'newname') { username }"

Notes:
  - Single quotes are auto-converted to double quotes for GraphQL
  - Use --jq for dot-path extraction (built-in, no deps)`,
  options: [
    { flags: ["--query", "-q"], dest: "query", metavar: "QUERY", help: "GraphQL query string" },
    { flags: ["--mutation", "-m"], dest: "mutation", metavar: "MUTATION", help: "GraphQL mutation string" },
    { flags: ["--jq"], dest: "jq", metavar: "PATH", help: "Extract value using dot-path (e.g., .me.username)" },
    { flags: ["--dash-url", "--api-url"], dest: "dash_url", metavar: "URL", help: "ML-Dash server URL (default: https://api.dash.ml)" },
  ],
  mutuallyExclusive: [{ dests: ["query", "mutation"], required: true }],
};

/** GraphQL wants double quotes; shells want single. Trade one for the other. */
export const fixQuotes = (q: string): string => q.replace(/'/g, '"');

export function buildQuery(query: string, isMutation: boolean): string {
  const q = fixQuotes(query.trim());
  if (q.startsWith("{") || q.startsWith("mutation") || q.startsWith("query")) return q;
  return isMutation ? `mutation { ${q} }` : `{ ${q} }`;
}

/** Dot-path lookup. A numeric segment indexes into an array, as in the Python CLI. */
export function extractPath(data: unknown, path: string): unknown {
  let cur = data;
  for (const key of path.replace(/^\.+/, "").split(".")) {
    if (!key) continue;
    if (Array.isArray(cur)) {
      const idx = Number(key);
      if (!Number.isInteger(idx)) throw new Error(`Cannot index array with '${key}'`);
      cur = cur[idx];
    } else if (cur !== null && typeof cur === "object") {
      if (!(key in (cur as Record<string, unknown>))) throw new Error(`Key '${key}' not found`);
      cur = (cur as Record<string, unknown>)[key];
    } else {
      throw new Error(`Cannot access '${key}' on ${cur === null ? "null" : typeof cur}`);
    }
  }
  return cur;
}

export async function run(args: ParsedArgs): Promise<number> {
  const ctx = resolveContext(args);
  if (!ctx.apiKey) {
    console.error(`${red("Error:")} ${notAuthenticatedMessage(ctx)}`);
    return 1;
  }

  try {
    const isMutation = typeof args.mutation === "string";
    const query = buildQuery(String(isMutation ? args.mutation : args.query), isMutation);
    let result: unknown = await makeClient(ctx).graphqlQuery(query);

    if (typeof args.jq === "string") {
      try {
        result = extractPath(result, args.jq);
      } catch (e) {
        console.error(red(`Error extracting path '${args.jq}': ${(e as Error).message}`));
        return 1;
      }
    }

    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    console.error(red(`Error: ${(e as Error).message}`));
    return 1;
  }
}
