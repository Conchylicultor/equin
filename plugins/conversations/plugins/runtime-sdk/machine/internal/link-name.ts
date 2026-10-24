// The file name of an agent's named claude (`named-claude.ts`) — what a macOS
// permission prompt shows as the asking app.

/** Bytes kept of the title — APFS names are at most 255 bytes. */
const MAX_TITLE_BYTES = 120;

/** `<title> · <id>`, as a file name: no `/`, no control characters, bounded. */
export function linkName(title: string | null, id: string): string {
  const clean = (title ?? "")
    .replace(/[\u0000-\u001f\u007f/:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!clean) return id;
  const bytes = new TextEncoder().encode(clean);
  const cut =
    bytes.length <= MAX_TITLE_BYTES
      ? clean
      : `${new TextDecoder()
          .decode(bytes.slice(0, MAX_TITLE_BYTES))
          .replace(/�+$/, "")
          .trimEnd()}…`;
  return `${cut} · ${id}`;
}
