import type { ServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { AnyIdKind } from "@plugins/ids/core";
import { IdKinds, type IdReferent } from "@plugins/ids/server";
import { Editor } from "@plugins/page/plugins/editor/server";
import { inlineChipNode } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/core";
import {
  InlineTokenReferentSource,
  type InlineTokenLiveRead,
} from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/server";
import { idChipPattern, idReferentTag, type IdChipSurface } from "../../core";

/**
 * A kind's id chip, server half — the twin of the web `idChip`, called from the
 * same family with the same `surfaces`:
 *
 * - `IdKinds.Referent` — the kind's `resolve(id)`, for any server reader;
 * - `InlineTokenReferentSource` over the chip's own pattern, so a model reading
 *   text that holds the id gets `<task id="…" title="…"/>` instead of an
 *   opaque id (the promise the chip's `modelText: "resolved"` makes);
 * - `Editor.InlineToken`, only when the chip belongs in `"document"`: a page
 *   block's doc can then hold the chip node, and the server must be able to
 *   read it back. Markdown-TRANSPARENT: a bare id has no character the inline
 *   markdown scan could misread, so masking it would only cost its marks.
 *   And `agentCodeSpan: "token"`: an agent's `` `task-…` `` lands as the chip.
 *
 * `live` is how a live value showing a stored text's chips as their titles (a
 * backlink's snippet) reads the referent — REQUIRED for a chip that belongs
 * in `"document"` (stored text holds it); a transcript-only chip never sits
 * in stored text as a chip, so it is derived: `not-in-text`.
 *
 * `referentTag` names the tag a model reads the resolved id as. It defaults to
 * the kind's label (`idReferentTag`); a family whose long-standing tag differs
 * (a `block-…` resolves to its PAGE, read as `<page …/>`) passes it, so the
 * model-facing text stays byte-identical across the move onto the kind.
 */
export function idChipServer(spec: {
  kind: AnyIdKind;
  surfaces: readonly IdChipSurface[];
  /**
   * How a live value reads the referent (`followedReferent` over a served
   * lookup carrying what `resolve` reads) — for a `"document"` chip only.
   */
  live?: InlineTokenLiveRead;
  resolve(id: string): Promise<IdReferent>;
  referentTag?: string;
}): ServerContribution[] {
  const { kind, surfaces, resolve } = spec;
  const pattern = idChipPattern(kind);
  const inDocuments = surfaces.includes("document");
  if (inDocuments && spec.live === undefined) {
    throw new Error(
      `idChipServer(${kind.prefix}): a chip that belongs in "document" sits in stored text, so a live value showing that text reads its referent — declare \`live\` (followedReferent over a served lookup, or untracked for a referent outside Postgres).`,
    );
  }
  if (!inDocuments && spec.live !== undefined) {
    throw new Error(
      `idChipServer(${kind.prefix}): a transcript-only chip never sits in stored text as a chip — its \`live\` read is derived (not-in-text); drop it.`,
    );
  }
  const live: InlineTokenLiveRead = spec.live ?? {
    kind: "not-in-text",
    reason: "a transcript-only chip: no stored text holds it as a chip",
  };
  const out: ServerContribution[] = [
    IdKinds.Referent({ kind, resolve }),
    InlineTokenReferentSource({
      kind: spec.referentTag ?? idReferentTag(kind),
      pattern,
      live,
      resolve,
    }),
  ];
  if (inDocuments) {
    out.push(
      Editor.InlineToken({
        pattern,
        markdownSpan: "transparent",
        // An agent backticking an id named the thing: the id has no other
        // spelling, so in its page write the span is the chip.
        agentCodeSpan: "token",
        node: inlineChipNode,
      }),
    );
  }
  return out;
}
