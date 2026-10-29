// The file name of an agent's named claude (`named-claude.ts`) — what a macOS
// permission prompt shows as the asking app, and what System Settings lists
// under each privacy permission. Product name first, then the id, so every
// agent sorts together under equin there instead of scattering by title.

import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";

/** Bytes kept of the title — APFS names are at most 255 bytes. */
const MAX_TITLE_BYTES = 120;

/** `equin · <id> · <title>`, as a file name: no `/`, no control characters, bounded. */
export function linkName(title: string | null, id: string): string {
  const prefix = `${PRODUCT_NAME} · ${id}`;
  const clean = (title ?? "")
    .replace(/[\u0000-\u001f\u007f/:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return prefix;
  const bytes = new TextEncoder().encode(clean);
  const cut =
    bytes.length <= MAX_TITLE_BYTES
      ? clean
      : `${new TextDecoder()
          .decode(bytes.slice(0, MAX_TITLE_BYTES))
          .replace(/�+$/, "")
          .trimEnd()}…`;
  return `${prefix} · ${cut}`;
}
