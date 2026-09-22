/**
 * Where a write is allowed to land.
 *
 * `download` claims it only ever writes into the `.dash` tree the user named
 * and into its own scratch directory. Every path component that decides where
 * a write goes — an experiment prefix, a metric name, a file's `pPath` and its
 * filename — is server-supplied metadata, so a hostile or broken server could
 * otherwise put `..` (or `C:`, or a backslash) in one of them and walk the
 * write out of the tree. These checks are the single place that is enforced.
 *
 * The rule is reject, not repair: a component that would leave the root raises
 * `UnsafePathError` and fails its section, rather than being rewritten into
 * some other path that quietly stores the data in the wrong place. Legal
 * nesting — `owner/project/folder/exp`, `train/loss`, `checkpoints/epoch-3` —
 * still passes.
 */
import { realpathSync } from "node:fs";
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

/**
 * A relative path that may nest: `owner/project/exp`, `train/loss`, `a/b/c`.
 * Returns the segments, so the caller joins from a root it controls rather
 * than from a string that could still be read as absolute.
 */
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

const contains = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Refuse a target reached through a symlink that leaves the root.
 *
 * The lexical check above cannot see this: `root/files` may already exist as a
 * link to `/tmp`, in which case a perfectly ordinary relative path writes
 * outside the tree. The deepest part of the target that exists is resolved
 * with realpath — which resolves links at every level — and has to still be
 * inside the resolved root.
 */
function checkSymlinkEscape(root: string, target: string, label: string, raw: string): void {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    // The root itself does not exist yet: there is no link to travel through.
    return;
  }
  let probe = target;
  for (;;) {
    let real: string;
    try {
      real = realpathSync(probe);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe || !contains(root, parent)) return;
      probe = parent;
      continue;
    }
    if (!contains(realRoot, real)) {
      throw new UnsafePathError(label, raw, `'${probe}' resolves outside the root`);
    }
    return;
  }
}

/**
 * Resolve `relative` under `root`, or throw. The returned path is inside the
 * root both lexically and after every existing symlink on it is resolved.
 */
export function resolveWithin(root: string, relative: string, label: string): string {
  const segments = safeRelativeSegments(label, relative);
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, ...segments);
  if (!contains(rootAbs, target)) {
    throw new UnsafePathError(label, relative, "resolves outside the root");
  }
  checkSymlinkEscape(rootAbs, target, label, relative);
  return target;
}
