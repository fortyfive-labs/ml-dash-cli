/**
 * fnmatch-compatible globbing.
 *
 * The Python CLI matched local experiment paths with `fnmatch.fnmatch` and let
 * the server match remote ones. Both accept `*`, `?` and `[...]` classes, and
 * — unlike shell globbing — `*` crosses `/`. A path-aware matcher would quietly
 * change which experiments a pattern like `tom/<any>/exp<any>` selects, so this deliberately
 * reproduces fnmatch's flat semantics.
 */
export function fnmatch(name: string, pattern: string): boolean {
  return fnmatchToRegExp(pattern).test(name);
}

export function fnmatchToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i++];
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "[") {
      let j = i;
      if (j < pattern.length && (pattern[j] === "!" || pattern[j] === "^")) j++;
      if (j < pattern.length && pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j >= pattern.length) {
        out += "\\[";
      } else {
        let body = pattern.slice(i, j);
        if (body.startsWith("!") || body.startsWith("^")) body = "^" + body.slice(1);
        out += "[" + body.replace(/\\/g, "\\\\") + "]";
        i = j + 1;
      }
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "s");
}

export const hasWildcard = (s: string): boolean => /[*?[]/.test(s);
