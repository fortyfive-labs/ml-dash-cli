/**
 * Where a write is allowed to land.
 *
 * `download` claims it only ever writes into the `.dash` tree the user named
 * and into its own scratch directory. Every path component that decides where
 * a write goes — an experiment prefix, a metric name, a file's `pPath` and its
 * filename — is server-supplied metadata, so a hostile or broken server could
 * otherwise put `..` (or `C:`, or a backslash) in one of them and walk the
 * write out of the tree.
 *
 * Two properties this file is responsible for, both learned from a review of
 * the first version:
 *
 *  1. **One root, and it is the `.dash` root the user chose.** A check
 *     anchored at a derived directory — `…/metrics`, `…/files` — trusts that
 *     directory to be inside the tree, which is exactly what is in question
 *     when `files` is itself a link to somewhere else. Every target is built
 *     and checked from `rootPath` down, in one pass, including the literal
 *     components (`files`, `data.jsonl`, `.files_metadata.json`), which can be
 *     links too.
 *  2. **Every component, not just the ones that exist.** Resolving the deepest
 *     *existing* ancestor with realpath misses a dangling symlink — realpath
 *     fails on it, which reads as "not there yet" — and misses a link at the
 *     leaf. Write targets are walked component by component with `lstat`,
 *     which sees a link whether or not it points at anything.
 *
 * The rule is reject, not repair: a component that would leave the root raises
 * `UnsafePathError` and fails its section, rather than being rewritten into
 * some other path that quietly stores the data in the wrong place. Legal
 * nesting — `owner/project/folder/exp`, `train/loss`, `checkpoints/epoch-3` —
 * still passes.
 */
import { lstatSync } from "node:fs";
import path from "node:path";

export class UnsafePathError extends Error {
  constructor(label: string, value: string, reason: string) {
    super(`unsafe ${label} ${JSON.stringify(value)}: ${reason}`);
    this.name = "UnsafePathError";
  }
}

const WINDOWS_DRIVE = /^[A-Za-z]:/;

/** Rules every component shares, whatever its shape. */
function checkComponent(label: string, value: string): void {
  if (typeof value !== "string") {
    throw new UnsafePathError(label, String(value), "is not a string");
  }
  if (value.includes("\0")) {
    throw new UnsafePathError(label, value, "contains a NUL byte");
  }
  if (value.includes("\\")) {
    // A backslash is a separator on Windows and a legal filename character on
    // POSIX; accepting it would make the same metadata escape on one platform
    // and not the other.
    throw new UnsafePathError(label, value, "contains a backslash separator");
  }
  if (WINDOWS_DRIVE.test(value)) {
    throw new UnsafePathError(label, value, "names a Windows drive");
  }
  if (value.startsWith("/") || path.isAbsolute(value)) {
    throw new UnsafePathError(label, value, "is an absolute path");
  }
}

/** One path segment: a filename, or a directory name that may not nest. */
export function safeSegment(label: string, value: string): string {
  checkComponent(label, value);
  if (value === "") throw new UnsafePathError(label, value, "is empty");
  if (value.includes("/")) {
    throw new UnsafePathError(label, value, "must be a single path segment");
  }
  if (value === "." || value === "..") {
    throw new UnsafePathError(label, value, "is a relative path component");
  }
  return value;
}

/** A relative path that may nest: `owner/project/exp`, `train/loss`. */
export function safeRelativeSegments(label: string, value: string): string[] {
  checkComponent(label, value);
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new UnsafePathError(label, value, `contains a '${segment}' segment`);
    }
  }
  const kept = segments.filter((s) => s !== "");
  if (kept.length === 0) throw new UnsafePathError(label, value, "is empty");
  return kept;
}

/**
 * One piece of a target path. `nested` marks the pieces that may legally carry
 * separators — a prefix, a metric name, a file's path — from the ones that are
 * a single name.
 */
export interface PathPart {
  label: string;
  value: string;
  nested?: boolean;
}

/** A literal component this code chose, not the server: `files`, `logs.jsonl`. */
export const literal = (value: string): PathPart => ({ label: "path component", value });

const contains = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Build a path under `root` from its parts, or throw.
 *
 * `mode: "write"` additionally refuses a target any part of which is a symlink
 * — dangling or not — because a link inside the tree redirects the write out
 * of it, and because following one to delete or overwrite would destroy a file
 * that is not ours. `mode: "read"` keeps the lexical rules only, so a user who
 * has symlinked their own metric data can still upload it.
 */
export function resolveUnderRoot(
  root: string,
  parts: PathPart[],
  mode: "read" | "write" = "write",
): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (part.nested) segments.push(...safeRelativeSegments(part.label, part.value));
    else segments.push(safeSegment(part.label, part.value));
  }

  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, ...segments);
  if (!contains(rootAbs, target)) {
    throw new UnsafePathError(
      parts.map((p) => p.value).join("/"),
      target,
      "resolves outside the root",
    );
  }
  if (mode === "write") {
    let current = rootAbs;
    for (const segment of segments) {
      current = path.join(current, segment);
      let stats;
      try {
        stats = lstatSync(current);
      } catch {
        // Does not exist: nothing here to redirect the write, and nothing
        // below it can exist either.
        break;
      }
      if (stats.isSymbolicLink()) {
        throw new UnsafePathError(
          parts.map((p) => p.value).join("/"),
          current,
          "is reached through a symbolic link inside the root",
        );
      }
    }
  }
  return target;
}
