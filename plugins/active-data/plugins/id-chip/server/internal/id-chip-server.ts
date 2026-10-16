import type { ServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { AnyIdKind } from "@plugins/ids/core";
import type { RoutedSource } from "@plugins/infra/plugins/query-resource/server";
import { IdKinds, type IdReferent } from "@plugins/ids/server";
import { Editor } from "@plugins/page/plugins/editor/server";
import { inlineChipNode } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/core";
import { InlineTokenReferentSource } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/server";
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
 *
 * `referentTag` names the tag a model reads the resolved id as. It defaults to
 * the kind's label (`idReferentTag`); a family whose long-standing tag differs
 * (a `block-…` resolves to its PAGE, read as `<page …/>`) passes it, so the
 * model-facing text stays byte-identical across the move onto the kind.
 */
export function idChipServer(spec: {
  kind: AnyIdKind;
  surfaces: readonly IdChipSurface[];
  /** The base tables `resolve` reads (`[]` when none) — never a view. */
  tables: readonly RoutedSource[];
  resolve(id: string): Promise<IdReferent>;
  referentTag?: string;
}): ServerContribution[] {
  const { kind, surfaces, resolve } = spec;
  const pattern = idChipPattern(kind);
  const out: ServerContribution[] = [
    IdKinds.Referent({ kind, resolve }),
    InlineTokenReferentSource({
      kind: spec.referentTag ?? idReferentTag(kind),
      pattern,
      tables: spec.tables,
      resolve,
    }),
  ];
  if (surfaces.includes("document")) {
    out.push(
      Editor.InlineToken({
        pattern,
        markdownSpan: "transparent",
        node: inlineChipNode,
      }),
    );
  }
  return out;
}
