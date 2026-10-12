import type { ForestGranularity, SerializedBlock } from "../../core";

/** Custom clipboard MIME carrying a serialized block forest (round-trips full
 *  structure); `text/plain` carries a markdown fallback for external apps. */
export const BLOCKS_MIME = "application/x-singularity-blocks+json";

/**
 * The `BLOCKS_MIME` payload: a forest AND what it was copied as.
 *
 * > A block copied WHOLE pastes as whole blocks — never merged into the text at
 * > the caret.
 *
 * That is a fact about the COPY, so the copy states it and the payload carries
 * it; a paste door cannot recover it from the forest's shape (one copied
 * paragraph and one pasted line of text parse to the same node). `"blocks"` is
 * the block-selection copy and the bare-caret whole-block copy; `"text"` is the
 * copy of an editor-owned text SPAN, whose ends are partial lines — so its
 * paste splices into the caret's line (Notion's model). All three go through
 * `writeForestToClipboard`. A text-range copy INSIDE one block is the
 * BROWSER's and writes no `BLOCKS_MIME` at all.
 */
export interface BlocksPayload {
  granularity: ForestGranularity;
  forest: SerializedBlock[];
}

/** Encode a copied forest with what it was copied AS (see {@link BlocksPayload}). */
export function encodeBlocksPayload(
  forest: SerializedBlock[],
  granularity: ForestGranularity,
): string {
  const payload: BlocksPayload = { granularity, forest };
  return JSON.stringify(payload);
}

/**
 * Decode a `BLOCKS_MIME` payload. A bare ARRAY is the pre-envelope spelling and
 * reads as `"blocks"`: every payload ever written that way came from a
 * whole-block copy (`writeForestToClipboard` was its only writer). Malformed
 * JSON, or a shape that is neither, is `{ ok: false }` — not our payload, so
 * the door declines and the browser's default runs, as it always has.
 */
export function decodeBlocksPayload(
  json: string,
): ({ ok: true } & BlocksPayload) | { ok: false } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { ok: false };
  }
  if (Array.isArray(raw))
    return {
      ok: true,
      granularity: "blocks",
      forest: raw as SerializedBlock[],
    };
  if (typeof raw !== "object" || raw === null) return { ok: false };
  const { granularity, forest } = raw as Record<string, unknown>;
  if (
    (granularity !== "blocks" && granularity !== "text") ||
    !Array.isArray(forest)
  )
    return { ok: false };
  return { ok: true, granularity, forest: forest as SerializedBlock[] };
}

/**
 * The text a `DataTransfer` carries, read with the SAME fallback Lexical's own
 * plain-text arm uses: `text/plain`, else `text/uri-list`
 * (`$insertDataTransferForRichText` → `@lexical/clipboard@0.44.0
 * LexicalClipboard.dev.mjs:121`).
 *
 * One helper so the two cannot drift. A transfer carrying ONLY `text/uri-list`
 * — a link dragged out of another browser tab, and some apps' copied links — is
 * invisible to a bare `getData("text/plain")`, so a classifier reading that
 * alone declines and hands the payload straight to the arm below it, which then
 * reads the URI list after all. Every classification of a transfer in this
 * plugin therefore goes through here.
 */
export function readTransferText(data: DataTransfer): string {
  return data.getData("text/plain") || data.getData("text/uri-list");
}

/**
 * The four ways a `DataTransfer` entering the page can resolve, decided purely
 * from its shape. Shared by every door — the block-selection-mode container
 * paste, the per-block caret paste, and the container's pointer DROP — so the
 * surfaces branch identically:
 *  - `file`     — a FILE; the attachment path owns it.
 *  - `forest`   — a `BLOCKS_MIME` payload (a copied block forest) to JSON.parse.
 *  - `markdown` — text to parse into a block forest.
 *  - `inline`   — newline-free text landing at an insertion point; leave the
 *                 native inline paste/drop alone.
 *
 * What a door does with a forest depends on whether it HAS an insertion point,
 * not on the arm: at one (a caret, a drop inside a block's text) the forest is
 * SPLICED there (`planSplice`), and without one (block-selection mode, a drop
 * outside any text) it lands as blocks after the anchor row. So a `markdown`
 * decision does not mean "becomes new blocks" — `para⏎` at a caret splices into
 * the caret's own line.
 */
export type TransferDecision =
  | { kind: "file" }
  | { kind: "forest"; json: string }
  | { kind: "markdown"; text: string }
  | { kind: "inline" };

/**
 * Classify a transfer from its primitive fields.
 *
 * > A `DataTransfer` entering the page is parsed into a FOREST unless it is
 * > newline-free text AND there is an inline insertion point to take it.
 *
 * A file wins outright; a block-forest payload beats text; text claims the
 * gesture as markdown unless both halves of the inline rule hold. The inline
 * arm is "no newline", not "one parsed paragraph": text without a line in it
 * cannot carry structure, so the native insert is exactly right for it (and
 * keeps url-paste, token-paste, `text/html` marks and the clipboard-insert
 * guard working), while ANY text with a newline — a lone `para⏎` included —
 * goes to the forest, whose door splices it at the point. Whatever the parse
 * yields, the splice puts it at the point, so no parse can be mistaken for
 * structure it does not have.
 *
 * `inline` is the caller's answer to *"is there an insertion point a single line
 * can land in?"* — true for a caret-in-block paste and for a drop whose target
 * sits inside a block's editing host, false for the block-selection-mode
 * container paste (which deliberately holds no caret) and for a drop over the
 * page's non-editable area. Empty text with `inline: false` therefore yields
 * `markdown`: every call site already declines on an empty parsed forest, so
 * that is the single place emptiness is handled.
 */
export function decideTransfer(opts: {
  isFile: boolean;
  blocksJson: string;
  text: string;
  inline: boolean;
}): TransferDecision {
  if (opts.isFile) return { kind: "file" };
  if (opts.blocksJson) return { kind: "forest", json: opts.blocksJson };
  if (opts.inline && !opts.text.includes("\n")) return { kind: "inline" };
  return { kind: "markdown", text: opts.text };
}
