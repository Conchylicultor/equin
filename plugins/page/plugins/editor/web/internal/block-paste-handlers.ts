import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { RowData } from "../../core";

/**
 * What the invoking paste path hands `build`: the fetcher bound to the
 * editor's own transport (its `useFetchEndpoint()`), so an upload from inside
 * a scope (the demo's browser server) lands on that scope's host, never the
 * page's.
 */
export interface BlockPasteContext {
  fetchEndpoint: FetchEndpoint;
}

/**
 * Generic block-paste-handler registry, owned by the editor plugin.
 *
 * Each attachment block type (image, video, audio, file) registers a handler
 * mapping a pasted file's MIME to a block type plus a `build(file, ctx)` that
 * uploads the file and returns the new block's data payload. The editor
 * consumes this registry in its two paste paths (the per-block Lexical paste
 * plugin and the block-selection-mode container paste) so it can create
 * attachment blocks from pasted files without naming any specific block type —
 * collection-consumer separation: the editor owns the generic interface, each
 * block contributes the internal details.
 */
export interface BlockPasteHandler {
  /** Stable id (e.g. "image"). */
  id: string;
  /** Block type to create from a pasted file of this kind (e.g. "image"). */
  type: string;
  /** MIME accept spec: "image/*", "video/*", "audio/*", or "*" (catch-all). */
  accept: string;
  /**
   * Upload the file and return the new block's data payload. `RowData`, not
   * `unknown`: an attachment block is text-less, and the paste path converts an
   * EXISTING empty block in place — a payload naming `text` would be writing
   * over a projection of that block's content doc.
   */
  build: (file: File, ctx: BlockPasteContext) => Promise<RowData>;
}

const handlers: BlockPasteHandler[] = [];

export function registerBlockPasteHandler(h: BlockPasteHandler): () => void {
  handlers.push(h);
  return () => {
    const idx = handlers.indexOf(h);
    if (idx >= 0) handlers.splice(idx, 1);
  };
}

// Turn an `accept` spec into a mime predicate: `"*"` → always; `"image/*"` →
// prefix match; an exact mime → equality. (Same logic as attachment-upload.)
function matchesAccept(accept: string, mime: string): boolean {
  if (accept === "*") return true;
  if (accept.endsWith("/*")) return mime.startsWith(accept.slice(0, -1));
  return mime === accept;
}

// How specific an `accept` spec is, so a concrete `image/*` handler always wins
// over the `"*"` catch-all (file): catch-all 0 < prefix 1 < exact mime 2.
function specificity(accept: string): number {
  if (accept === "*") return 0;
  if (accept.endsWith("/*")) return 1;
  return 2;
}

/**
 * Among handlers whose `accept` matches `mime`, return the most specific
 * (highest specificity); null if none match.
 */
export function resolveBlockPasteHandler(mime: string): BlockPasteHandler | null {
  let best: BlockPasteHandler | null = null;
  for (const h of handlers) {
    if (!matchesAccept(h.accept, mime)) continue;
    if (!best || specificity(h.accept) > specificity(best.accept)) best = h;
  }
  return best;
}

/**
 * Scan a clipboard `DataTransfer` for a pasted file and resolve the most
 * specific handler for it. `getAsFile()` is called synchronously here because
 * clipboard items are only valid during the paste event.
 */
export function resolvePastedBlock(
  data: DataTransfer | null,
): { file: File; handler: BlockPasteHandler } | null {
  if (!data) return null;
  let best: { file: File; handler: BlockPasteHandler } | null = null;
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const handler = resolveBlockPasteHandler(item.type);
    if (!handler) continue;
    if (best && specificity(handler.accept) <= specificity(best.handler.accept)) continue;
    const file = item.getAsFile();
    if (!file) continue;
    best = { file, handler };
  }
  return best;
}
