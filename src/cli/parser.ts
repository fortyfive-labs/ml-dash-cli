/**
 * A small argparse-shaped option parser.
 *
 * The flag surface is a contract: the Python CLI's `add_parser` functions gave
 * several options more than two spellings (`--dash-url`/`--api-url`, and
 * `-p`/`--pref`/`--prefix`/`--proj`/`--project`), and argparse also accepts
 * unambiguous prefixes and `--flag=value`. `commander` keeps only a short and
 * a long form per option, so porting through it would silently drop spellings
 * that existing scripts pass. This reproduces the subset argparse actually
 * exercises instead: aliases, `=`-joined values, `-p value`, choices, required
 * options and mutually exclusive groups.
 *
 * Abbreviation matching is deliberately NOT implemented — argparse's prefix
 * matching turns a future new option into a silent behaviour change for an
 * existing abbreviation, and no documented invocation depends on it.
 */
import { bold, red } from "../util/ansi.js";

export interface OptionSpec {
  /** Every accepted spelling, e.g. ["--dash-url", "--api-url"]. */
  flags: string[];
  /** Key in the parsed result. */
  dest: string;
  /** A flag takes no value and yields boolean true. */
  boolean?: boolean;
  required?: boolean;
  choices?: string[];
  help: string;
  /** Placeholder shown in help for value-taking options. */
  metavar?: string;
}

export interface PositionalSpec {
  dest: string;
  metavar: string;
  help: string;
  /** Used when the argument is absent, matching argparse's `default=`. */
  default?: string;
}

export interface CommandSpec {
  name: string;
  help: string;
  description?: string;
  options: OptionSpec[];
  /** Optional trailing arguments, consumed in order. All are `nargs="?"`. */
  positionals?: PositionalSpec[];
  /** Groups where at most one member may appear; `required` makes it exactly one. */
  mutuallyExclusive?: { dests: string[]; required?: boolean }[];
}

export class ParseError extends Error {}

export type ParsedArgs = Record<string, string | boolean | undefined>;

export function parseArgs(spec: CommandSpec, argv: string[]): ParsedArgs {
  const byFlag = new Map<string, OptionSpec>();
  for (const opt of spec.options) {
    for (const f of opt.flags) byFlag.set(f, opt);
  }

  const out: ParsedArgs = {};
  const seen = new Set<string>();
  const positionals = spec.positionals ?? [];
  let nextPositional = 0;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === "--help" || token === "-h") {
      out.help = true;
      return out;
    }
    if (!token.startsWith("-") || token === "-") {
      if (nextPositional >= positionals.length) {
        throw new ParseError(`unrecognized argument: ${token}`);
      }
      const positional = positionals[nextPositional++];
      out[positional.dest] = token;
      seen.add(positional.dest);
      continue;
    }

    // `--flag=value` and `--flag value` are the same thing to argparse.
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

    const opt = byFlag.get(flag);
    if (!opt) throw new ParseError(`unrecognized argument: ${flag}`);

    if (opt.boolean) {
      if (inlineValue !== undefined) {
        throw new ParseError(`argument ${flag}: ignored explicit argument '${inlineValue}'`);
      }
      out[opt.dest] = true;
      seen.add(opt.dest);
      continue;
    }

    let value: string;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      // A value that itself looks like a known flag means the value is missing.
      const next = argv[i + 1];
      if (next === undefined || byFlag.has(next)) {
        throw new ParseError(`argument ${flag}: expected one argument`);
      }
      value = next;
      i++;
    }

    if (opt.choices && !opt.choices.includes(value)) {
      throw new ParseError(
        `argument ${flag}: invalid choice: '${value}' (choose from ${opt.choices
          .map((c) => `'${c}'`)
          .join(", ")})`,
      );
    }
    out[opt.dest] = value;
    seen.add(opt.dest);
  }

  for (const group of spec.mutuallyExclusive ?? []) {
    const present = group.dests.filter((d) => seen.has(d));
    if (present.length > 1) {
      const names = group.dests.map((d) => flagFor(spec, d)).join(" / ");
      throw new ParseError(`arguments ${names}: not allowed with each other`);
    }
    if (group.required && present.length === 0) {
      const names = group.dests.map((d) => flagFor(spec, d)).join(" / ");
      throw new ParseError(`one of the arguments ${names} is required`);
    }
  }

  for (const positional of positionals) {
    if (!seen.has(positional.dest) && positional.default !== undefined) {
      out[positional.dest] = positional.default;
    }
  }

  for (const opt of spec.options) {
    if (opt.required && !seen.has(opt.dest)) {
      throw new ParseError(`the following arguments are required: ${opt.flags.join("/")}`);
    }
  }

  return out;
}

const flagFor = (spec: CommandSpec, dest: string): string =>
  spec.options.find((o) => o.dest === dest)?.flags.join("/") ?? dest;

export function renderCommandHelp(spec: CommandSpec): string {
  const lines: string[] = [];
  const positionals = spec.positionals ?? [];
  const usageTail = positionals.map((p) => ` [${p.metavar}]`).join("");
  lines.push(bold(`usage: ml-dash ${spec.name} [options]${usageTail}`));
  lines.push("");
  if (spec.description) {
    lines.push(spec.description.trimEnd());
    lines.push("");
  }
  if (positionals.length > 0) {
    lines.push(bold("positional arguments:"));
    const width = Math.max(...positionals.map((p) => p.metavar.length));
    for (const p of positionals) lines.push(`  ${p.metavar.padEnd(width)}  ${p.help}`);
    lines.push("");
  }
  lines.push(bold("options:"));
  const rendered = spec.options.map((o) => {
    const value = o.boolean ? "" : ` ${o.metavar ?? o.dest.toUpperCase()}`;
    return [o.flags.join(", ") + value, o.help];
  });
  const width = Math.max(...rendered.map(([l]) => l.length), "-h, --help".length);
  lines.push(`  ${"-h, --help".padEnd(width)}  show this help message and exit`);
  for (const [left, help] of rendered) lines.push(`  ${left.padEnd(width)}  ${help}`);
  return lines.join("\n");
}

export function renderRootHelp(commands: CommandSpec[], available: string[]): string {
  const lines: string[] = [];
  lines.push(bold("usage: ml-dash COMMAND [options]"));
  lines.push("");
  lines.push("ML-Dash: ML experiment tracking and data storage CLI");
  lines.push("");
  lines.push("View your experiments, statistics, and plots online at:");
  lines.push("  https://dash.ml");
  lines.push("");
  lines.push(bold("commands:"));
  const width = Math.max(...commands.map((c) => c.name.length));
  for (const c of commands) {
    if (!available.includes(c.name)) continue;
    lines.push(`  ${c.name.padEnd(width)}  ${c.help}`);
  }
  lines.push("");
  lines.push("Run 'ml-dash COMMAND --help' for command-specific options.");
  return lines.join("\n");
}

export const usageError = (command: string, message: string): string =>
  `${red("error:")} ${message}\n\nRun 'ml-dash ${command} --help' for usage.`;
