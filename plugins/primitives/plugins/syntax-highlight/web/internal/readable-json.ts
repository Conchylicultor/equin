/**
 * `JSON.stringify(value, null, 2)` for a reader: a string holding newlines is
 * written across lines — each continuation line indented one level below the
 * key that holds it, so the structure still reads — instead of as one line of
 * `\n` escapes. Everything else is exactly `JSON.stringify`'s output (the same
 * escapes, key order, `undefined`/function members dropped, `toJSON` honoured).
 *
 * The result is JSON except for those line breaks, and the JSON grammar shiki
 * highlights with spans a string across lines, so it colours as JSON.
 */
export function readableJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2) as string | undefined;
  if (text === undefined) return String(value);
  // A string literal on a line of JSON.stringify's output never contains a raw
  // newline, so each line is processed on its own: its leading spaces are the
  // indent of the member, and every `\n` escape (one not preceded by an
  // escaping backslash) inside a string literal becomes a line break.
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\\n")) return line;
      const indent = " ".repeat(line.length - line.trimStart().length + 2);
      return breakStringNewlines(line, indent);
    })
    .join("\n");
}

function breakStringNewlines(line: string, indent: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = line[i + 1];
      i++;
      // `\n` — a newline in the value; `\r\n` folds into the same break.
      if (next === "n") out += "\n" + indent;
      else if (next === "r" && line.slice(i + 1, i + 3) === "\\n") {
        out += "\n" + indent;
        i += 2;
      } else out += ch + next;
      continue;
    }
    if (ch === '"') inString = false;
    out += ch;
  }
  return out;
}
