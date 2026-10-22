import { runsOfNode } from "../../core";
import type { RichText } from "../../core";
import { blockDocOwnerOf, type BlockDocs } from "./collab-session";

/**
 * A block's text as it stands NOW, for a decision about what the user sees —
 * "is the last line already empty?", "is this block blank, so a pasted file
 * replaces it?".
 *
 * The row's `data.text` is a ~1 s-debounced projection of the block's content
 * doc, so asking the row right after typing answers for the text as it was
 * before the typing run: a line the user just filled still reads empty, and a
 * click below the page lands the caret at its end instead of opening a fresh
 * line. The doc is the owner, so it is read whenever it can answer — a live
 * owner whose doc is AUTHORITATIVE. An owner still waiting on its subscription
 * holds an empty doc because nothing arrived, not because the block is empty,
 * so that case (and a block never opened here) falls back to the row.
 * `docs` is the editor's transport's registry (`useBlockDocs()`).
 */
export function liveRunsOf(
  docs: BlockDocs,
  block: { id: string; data?: unknown },
): RichText {
  const owner = blockDocOwnerOf(docs, block.id);
  return owner && owner.docAuthoritative ? owner.runsNow() : runsOfNode(block);
}
