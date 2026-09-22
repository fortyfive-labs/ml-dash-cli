/**
 * `ml-dash list` — discover projects, experiments and tracks on the server.
 *
 * Three modes share one flag, as in the Python CLI:
 *   no  -p            → projects in the namespace
 *   -p 'proj'         → experiments in that project
 *   -p 'ns/pr/ex*'    → server-side glob search across experiments
 *   --tracks -p ns/pr/ex → tracks in one experiment
 *
 * A `-p` value containing `*`, `?` or `[` switches to search and is expanded
 * to a three-segment pattern first, because the server matches the full
 * `namespace/project/experiment` path: `tes*` alone would match nothing.
 *
 * Paging is interactive only when there is a terminal to read a keypress from.
 * The Python CLI put the tty into raw mode unconditionally, which throws when
 * stdout is a pipe — so `ml-dash list | head` died on its own pager. Here a
 * non-tty prints the first page and says how to reach the rest.
 */
import { RemoteClient } from "../client.js";
import { makeClient, notAuthenticatedMessage, resolveContext } from "../cli/context.js";
import type { CommandSpec, ParsedArgs } from "../cli/parser.js";
import { hasWildcard } from "../util/glob.js";
import { cyan, dim, green, red, renderTable, yellow, type Column } from "../util/ansi.js";

export const PAGE_SIZE = 50;

export const spec: CommandSpec = {
  name: "list",
  help: "List projects and experiments on remote server",
  description: "Discover projects and experiments available on the remote ML-Dash server.",
  options: [
    { flags: ["--dash-url", "--api-url"], dest: "dash_url", metavar: "URL", help: "ML-Dash server URL (defaults to config or https://api.dash.ml)" },
    { flags: ["-n", "--namespace"], dest: "namespace", metavar: "NS", help: "Namespace slug for all queries (defaults to authenticated user's namespace)" },
    { flags: ["-p", "--pref", "--prefix", "--proj", "--project"], dest: "project", metavar: "PROJECT", help: "List experiments in this project. Supports glob patterns — always quote them: -p 'tom/tut*'" },
    { flags: ["--status"], dest: "status", metavar: "STATUS", choices: ["COMPLETED", "RUNNING", "FAILED", "ARCHIVED"], help: "Filter experiments by status" },
    { flags: ["--tags"], dest: "tags", metavar: "TAGS", help: "Filter experiments by tags (comma-separated)" },
    { flags: ["--tracks"], dest: "tracks", boolean: true, help: "List tracks in experiment (requires --project as 'namespace/project/experiment')" },
    { flags: ["--topic-filter"], dest: "topic_filter", metavar: "TOPIC", help: "Filter tracks by topic (e.g., 'robot/*')" },
    { flags: ["--detailed"], dest: "detailed", boolean: true, help: "Show detailed information" },
    { flags: ["-v", "--verbose"], dest: "verbose", boolean: true, help: "Verbose output" },
  ],
};

// ── formatting ───────────────────────────────────────────────────────────────

export function formatTimestamp(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);
  const days = Math.floor(seconds / 86400);
  if (days > 365) { const y = Math.floor(days / 365); return `${y} year${y > 1 ? "s" : ""} ago`; }
  if (days > 30) { const m = Math.floor(days / 30); return `${m} month${m > 1 ? "s" : ""} ago`; }
  if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`;
  const rest = seconds % 86400;
  if (rest > 3600) { const h = Math.floor(rest / 3600); return `${h} hour${h > 1 ? "s" : ""} ago`; }
  if (rest > 60) { const m = Math.floor(rest / 60); return `${m} minute${m > 1 ? "s" : ""} ago`; }
  return "just now";
}

const styleStatus = (status: string): string => {
  if (status === "COMPLETED") return green(status);
  if (status === "RUNNING") return yellow(status);
  if (status === "FAILED") return red(status);
  if (status === "ARCHIVED") return dim(status);
  return status;
};

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

const summariseTags = (tags: string[]): string => {
  const shown = tags.slice(0, 3).join(", ");
  return (tags.length > 3 ? `${shown} +${tags.length - 3}` : shown) || "-";
};

const caption = (offset: number, total: number, noun: string): string => {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  return `Page ${page}/${totalPages}  ·  ${total} ${noun}${total !== 1 ? "s" : ""} total`;
};

// ── paging ───────────────────────────────────────────────────────────────────

/** One keypress, no Enter. 'next' | 'prev' | 'quit'. */
function readKey(): Promise<"next" | "prev" | "quit"> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", (buf: Buffer) => {
      stdin.setRawMode(false);
      stdin.pause();
      const s = buf.toString("utf8");
      if (s === "\u001b[C" || s === "n" || s === "\r" || s === "\n" || s === " ") return resolve("next");
      if (s === "\u001b[D" || s === "p" || s === "b") return resolve("prev");
      resolve("quit");
    });
  });
}

interface Page {
  total: number;
  /** Rendered table for this page, or null when the page is empty. */
  table: string | null;
}

/** Fetch → print → wait for a key, until the user leaves or the pages run out. */
async function paginate(fetchPage: (offset: number) => Promise<Page>, emptyMessage: string): Promise<number> {
  let offset = 0;
  for (;;) {
    const { total, table } = await fetchPage(offset);
    if (!table) {
      if (offset === 0) console.log(yellow(emptyMessage));
      return 0;
    }
    console.log(table);

    const hasNext = offset + PAGE_SIZE < total;
    const hasPrev = offset > 0;
    if (!hasNext && !hasPrev) return 0;

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      if (hasNext) {
        console.log(dim("More results available — run in a terminal to page, or narrow with -p/--status."));
      }
      return 0;
    }

    const nav = [hasPrev ? "[b/←] prev" : "", hasNext ? "[n/→] next" : "", "[q] quit"].filter(Boolean);
    process.stdout.write(`${dim(nav.join("  "))}  `);
    const key = await readKey();
    process.stdout.write("\n");
    if (key === "next" && hasNext) offset += PAGE_SIZE;
    else if (key === "prev" && hasPrev) offset -= PAGE_SIZE;
    else return 0;
  }
}

// ── modes ────────────────────────────────────────────────────────────────────

const EXPERIMENT_COLUMNS: Column[] = [
  { header: "Experiment" },
  { header: "Status", align: "center" },
  { header: "Metrics", align: "right" },
  { header: "Logs", align: "right" },
  { header: "Tracks", align: "right" },
  { header: "Files", align: "right" },
];

function experimentRow(exp: any, detailed: boolean, timeField: "createdAt" | "startedAt"): string[] {
  const row = [
    cyan(exp.displayPath || exp.name),
    styleStatus(exp.status ?? "UNKNOWN"),
    String((exp.metrics ?? []).length),
    String(exp.logMetadata?.totalLogs ?? 0),
    String(exp.trackCount ?? 0),
    String((exp.files ?? []).length),
  ];
  if (detailed) {
    row.push(summariseTags(exp.tags ?? []));
    row.push(exp[timeField] ? formatTimestamp(exp[timeField]) : "-");
  }
  return row;
}

const matchesTags = (exp: any, tags: string[] | null): boolean =>
  !tags || (exp.tags ?? []).some((t: string) => tags.includes(t));

export async function listTracks(
  client: RemoteClient,
  experimentPath: string,
  topicFilter: string | undefined,
  verbose: boolean,
): Promise<number> {
  const parts = experimentPath.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 3) {
    console.error(`${red("Error:")} Experiment path must be 'namespace/project/experiment'`);
    return 1;
  }
  const [, project, experiment] = parts;

  try {
    const exp = await client.getExperimentGraphql(project, experiment);
    if (!exp) {
      console.error(`${red("Error:")} Experiment '${experiment}' not found in project '${project}'`);
      return 1;
    }
    const tracks = await client.listTracks(String(exp.id), topicFilter);
    if (tracks.length === 0) {
      console.log(yellow("No tracks found"));
      return 0;
    }

    const rows = tracks.map((track: any) => {
      const cols: string[] = track.columns ?? [];
      const columns = cols.slice(0, 5).join(", ") + (cols.length > 5 ? `, ... (+${cols.length - 5})` : "");
      const first = track.firstTimestamp;
      const last = track.lastTimestamp;
      const range = first != null && last != null ? `${Number(first).toFixed(3)} - ${Number(last).toFixed(3)}` : "N/A";
      return [cyan(track.topic), String(track.totalEntries ?? 0), dim(columns), dim(range)];
    });

    console.log(
      renderTable(
        [{ header: "Topic" }, { header: "Entries", align: "right" }, { header: "Columns" }, { header: "Time Range" }],
        rows,
        { title: `\nTracks in ${experimentPath}\n` },
      ),
    );
    return 0;
  } catch (e) {
    console.error(`${red("Error listing tracks:")} ${(e as Error).message}`);
    if (verbose) console.error((e as Error).stack);
    return 1;
  }
}

async function listProjects(client: RemoteClient, namespaceSlug: string | undefined, verbose: boolean): Promise<number> {
  try {
    return await paginate(async (offset) => {
      const { projects, totalCount } = await client.listProjectsGraphql(namespaceSlug, PAGE_SIZE, offset);
      if (projects.length === 0) return { total: totalCount, table: null };
      const rows = projects.map((p: any) => [
        cyan(p.slug),
        String(p.experimentCount ?? 0),
        dim(truncate(p.description ?? "", 50)),
      ]);
      return {
        total: totalCount,
        table: renderTable(
          [{ header: "Project" }, { header: "Experiments", align: "right" }, { header: "Description" }],
          rows,
          { title: "\nProjects", caption: caption(offset, totalCount, "project") },
        ),
      };
    }, "No projects found");
  } catch (e) {
    console.error(`${red("Error listing projects:")} ${(e as Error).message}`);
    if (verbose) console.error((e as Error).stack);
    return 1;
  }
}

async function listExperiments(
  client: RemoteClient,
  project: string,
  opts: { namespaceSlug?: string; status?: string; tags: string[] | null; detailed: boolean; verbose: boolean },
): Promise<number> {
  try {
    return await paginate(async (offset) => {
      const { experiments, totalCount } = await client.listExperimentsGraphql(project, {
        status: opts.status,
        namespaceSlug: opts.namespaceSlug,
        limit: PAGE_SIZE,
        offset,
      });
      const filtered = experiments.filter((e: any) => matchesTags(e, opts.tags));
      if (filtered.length === 0) return { total: totalCount, table: null };

      const columns = opts.detailed
        ? [...EXPERIMENT_COLUMNS, { header: "Tags" }, { header: "Created" }]
        : EXPERIMENT_COLUMNS;
      return {
        total: totalCount,
        table: renderTable(columns, filtered.map((e: any) => experimentRow(e, opts.detailed, "createdAt")), {
          title: `\nExperiments in project: ${project}`,
          caption: caption(offset, totalCount, "experiment"),
        }),
      };
    }, `No experiments found in project: ${project}`);
  } catch (e) {
    console.error(`${red("Error listing experiments:")} ${(e as Error).message}`);
    if (opts.verbose) console.error((e as Error).stack);
    return 1;
  }
}

/** Expand a one- or two-segment pattern to the three-segment path the server matches. */
export function searchPattern(project: string, namespace: string): string {
  if (!project.includes("/")) return `${namespace}/${project}/*`;
  if (project.split("/").length === 2) return `${project}/*`;
  return project;
}

async function searchExperiments(
  client: RemoteClient,
  pattern: string,
  opts: { status?: string; tags: string[] | null; detailed: boolean; verbose: boolean },
): Promise<number> {
  try {
    return await paginate(async (offset) => {
      const { experiments, totalCount } = await client.searchExperimentsGraphql(pattern, PAGE_SIZE, offset);
      // The search endpoint does not filter on status or tags, so both are
      // applied here — which means they narrow the page, not the total.
      const filtered = experiments
        .filter((e: any) => !opts.status || e.status === opts.status)
        .filter((e: any) => matchesTags(e, opts.tags));
      if (filtered.length === 0) return { total: totalCount, table: null };

      const columns: Column[] = [
        { header: "Project" },
        ...EXPERIMENT_COLUMNS,
        ...(opts.detailed ? [{ header: "Tags" }, { header: "Started" }] : []),
      ];
      const rows = filtered.map((e: any) => [
        dim(e.project?.slug ?? ""),
        ...experimentRow(e, opts.detailed, "startedAt"),
      ]);
      return {
        total: totalCount,
        table: renderTable(columns, rows, {
          title: `\nSearch results for: ${pattern}`,
          caption: caption(offset, totalCount, "experiment"),
        }),
      };
    }, `No experiments match pattern: ${pattern}`);
  } catch (e) {
    console.error(`${red("Error searching experiments:")} ${(e as Error).message}`);
    if (opts.verbose) console.error((e as Error).stack);
    return 1;
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

export async function run(args: ParsedArgs): Promise<number> {
  const ctx = resolveContext(args);
  if (!ctx.apiKey) {
    console.error(`${red("Error:")} ${notAuthenticatedMessage(ctx)}`);
    return 1;
  }
  const verbose = args.verbose === true;
  const detailed = args.detailed === true;
  const project = typeof args.project === "string" ? args.project : undefined;
  const tags = typeof args.tags === "string" ? args.tags.split(",").map((t) => t.trim()) : null;
  const status = typeof args.status === "string" ? args.status : undefined;

  if (args.tracks) {
    if (!project) {
      console.error(`${red("Error:")} --project is required for listing tracks`);
      console.error("Example: ml-dash list --tracks --project namespace/project/experiment");
      return 1;
    }
    const parts = project.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 3) {
      console.error(`${red("Error:")} For tracks, --project must be 'namespace/project/experiment'`);
      return 1;
    }
    return listTracks(makeClient(ctx, parts[0]), project, typeof args.topic_filter === "string" ? args.topic_filter : undefined, verbose);
  }

  const wildcard = project ? hasWildcard(project) : false;
  let namespace: string | undefined;
  let projectSlug: string | undefined;
  if (project) {
    const parts = project.replace(/^\/+|\/+$/g, "").split("/");
    if (project.includes("/")) {
      namespace = parts[0];
      projectSlug = parts[1];
    } else if (!wildcard) {
      projectSlug = project;
    }
  }

  const client = makeClient(ctx, namespace);

  let effectiveNamespace: string;
  try {
    effectiveNamespace =
      (typeof args.namespace === "string" ? args.namespace : undefined) ||
      namespace ||
      (await client.namespace());
  } catch (e) {
    console.error(`${red("Error connecting to remote:")} ${(e as Error).message}`);
    if (verbose) console.error((e as Error).stack);
    return 1;
  }

  if (!project) return listProjects(client, effectiveNamespace, verbose);

  if (wildcard) {
    return searchExperiments(client, searchPattern(project, effectiveNamespace), { status, tags, detailed, verbose });
  }

  console.log(dim(`Using namespace: ${effectiveNamespace}`));
  return listExperiments(client, projectSlug!, { namespaceSlug: effectiveNamespace, status, tags, detailed, verbose });
}
