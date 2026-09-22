/**
 * Minimal ANSI styling + table rendering.
 *
 * The Python CLI used `rich`. Porting `rich` wholesale would drag a rendering
 * engine into a single-file binary for the sake of a handful of tables, so the
 * subset that the CLI actually uses lives here instead: colours, a box table,
 * and a panel. Colour is suppressed when stdout is not a TTY or NO_COLOR is
 * set, so piping `ml-dash list` into a file yields plain text.
 */

const enabled = (): boolean => {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return process.stdout.isTTY === true;
};

const wrap = (code: number, close: number) => (s: string) =>
  enabled() ? `\u001b[${code}m${s}\u001b[${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const cyan = wrap(36, 39);

/** Visible width, ignoring the escape sequences the styles above insert. */
export const visibleWidth = (s: string): number =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\u001b\[[0-9;]*m/g, "").length;

const pad = (s: string, width: number, align: "left" | "right" | "center"): string => {
  const gap = Math.max(0, width - visibleWidth(s));
  if (align === "right") return " ".repeat(gap) + s;
  if (align === "center") {
    const l = Math.floor(gap / 2);
    return " ".repeat(l) + s + " ".repeat(gap - l);
  }
  return s + " ".repeat(gap);
};

export interface Column {
  header: string;
  align?: "left" | "right" | "center";
}

/** Rounded-box table, the same shape `rich.box.ROUNDED` produced. */
export function renderTable(
  columns: Column[],
  rows: string[][],
  opts: { title?: string; caption?: string } = {},
): string {
  const widths = columns.map((c, i) =>
    Math.max(visibleWidth(c.header), ...rows.map((r) => visibleWidth(r[i] ?? ""))),
  );
  const line = (l: string, m: string, r: string) =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;

  const out: string[] = [];
  if (opts.title) out.push(bold(opts.title));
  out.push(line("╭", "┬", "╮"));
  out.push("│ " + columns.map((c, i) => pad(bold(c.header), widths[i], c.align ?? "left")).join(" │ ") + " │");
  out.push(line("├", "┼", "┤"));
  for (const row of rows) {
    out.push(
      "│ " + columns.map((c, i) => pad(row[i] ?? "", widths[i], c.align ?? "left")).join(" │ ") + " │",
    );
  }
  out.push(line("╰", "┴", "╯"));
  if (opts.caption) out.push(dim(opts.caption));
  return out.join("\n");
}

/** Bordered panel, the shape `rich.panel.Panel` produced. */
export function renderPanel(body: string, opts: { title?: string } = {}): string {
  const lines = body.split("\n");
  const width = Math.max(
    ...lines.map(visibleWidth),
    opts.title ? visibleWidth(opts.title) + 2 : 0,
  );
  const top = opts.title
    ? "╭─ " + opts.title + " " + "─".repeat(Math.max(0, width - visibleWidth(opts.title) - 1)) + "╮"
    : "╭" + "─".repeat(width + 2) + "╮";
  const out = [top];
  for (const l of lines) out.push("│ " + pad(l, width, "left") + " │");
  out.push("╰" + "─".repeat(width + 2) + "╯");
  return out.join("\n");
}

export function formatBytes(n: number): string {
  let v = n;
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (v < 1024) return `${v.toFixed(2)} ${unit}`;
    v /= 1024;
  }
  return `${v.toFixed(2)} TB`;
}
