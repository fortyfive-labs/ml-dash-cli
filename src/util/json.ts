/**
 * JSON parsing that does not destroy Snowflake IDs.
 *
 * ml-dash node, experiment, project and file IDs are 64-bit Snowflakes. The
 * server sends most of them as JSON strings, but not all — `upload_file`'s
 * response and some GraphQL paths hand back bare numbers. `JSON.parse` turns
 * those into IEEE-754 doubles, and a 19-digit Snowflake loses its last two or
 * three digits in the process. Nothing throws: the ID simply comes back
 * slightly wrong, and the 404 surfaces later at an unrelated call.
 *
 * So numbers that cannot survive a round trip are quoted before parsing, and
 * every ID stays a string end to end.
 */

/** Rewrite unsafe integer literals as strings, leaving strings and floats alone. */
export function preserveBigIntegers(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (c === '"') {
      // Copy the string literal verbatim — digits inside it are not numbers.
      const start = i++;
      while (i < n) {
        if (text[i] === "\\") i += 2;
        else if (text[i] === '"') {
          i++;
          break;
        } else i++;
      }
      out += text.slice(start, i);
      continue;
    }

    if (c === "-" || (c >= "0" && c <= "9")) {
      const start = i;
      if (text[i] === "-") i++;
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
      const isInteger = !(i < n && (text[i] === "." || text[i] === "e" || text[i] === "E"));
      while (i < n && /[0-9.eE+-]/.test(text[i])) i++;
      const literal = text.slice(start, i);
      // Only integers, and only those outside the exactly-representable range.
      out += isInteger && !Number.isSafeInteger(Number(literal)) ? `"${literal}"` : literal;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

export function parseJson<T = any>(text: string): T {
  return JSON.parse(preserveBigIntegers(text)) as T;
}

/** Coerce whatever the server sent for an ID into a string, losslessly. */
export function asId(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "bigint") return v.toString();
  return String(v);
}
