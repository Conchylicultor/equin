/**
 * A label as Mermaid writes it, as the text it means: surrounding quotes and
 * markdown-string backticks dropped, `<br>` as a newline, `#quot;` / `#35;`
 * entity codes decoded.
 */
export function cleanLabel(raw: string): string {
  let s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s.length >= 2 && s.startsWith("`") && s.endsWith("`")) s = s.slice(1, -1);
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/#quot;/g, '"')
    .replace(/#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .trim();
}

/**
 * The source's statement lines: trimmed, blank lines, `%%` comments and
 * `%%{init}%%` directives dropped, a leading `---` front-matter block skipped.
 * Each keeps its 1-based source line number for the reason an unread line gives.
 */
export function statementLines(
  source: string,
): Array<{ line: number; text: string }> {
  const raw = source.split(/\r?\n/);
  let start = 0;
  if (raw[0]?.trim() === "---") {
    const close = raw.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) start = close + 1;
  }
  const out: Array<{ line: number; text: string }> = [];
  for (let i = start; i < raw.length; i++) {
    const text = raw[i]!.trim();
    if (text === "" || text.startsWith("%%")) continue;
    out.push({ line: i + 1, text });
  }
  return out;
}
