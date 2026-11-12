import { pageData, textOf } from "@plugins/page/plugins/editor/core";
import type { SearchDoc } from "@plugins/search/plugins/engine/core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { defineSourceSet } from "@plugins/packages/plugins/source-digest/core";

// What a page's search document IS, as a pure function of its blocks — kept in
// its own small module because its code is the stamp of every stored doc: the
// boot backfill (`backfill.ts`) re-derives the corpus only when this module's
// code (and what it loads) changes. Reading the blocks and writing the doc
// live in `reindex-page.ts`; changing them changes no stored doc.

// The search source id this plugin owns.
export const SOURCE = "pages";

/** The code every stored `pages` search doc was derived by. */
export const pageSearchDocCode = defineSourceSet(
  "how a page becomes its search document (the `pages` search docs)",
);
pageSearchDocCode.include(import.meta);

// The freshly-derived search document for a page plus a content fingerprint of
// everything that document encodes. The fingerprint is stamped into the doc's
// `metadata` so a later run can compare it against what is already indexed and
// skip re-upserting an unchanged page.
export interface BuiltPageSearchDoc {
  doc: SearchDoc;
  contentHash: string;
}

// Title (the page block's) + body (its content blocks' plain text). The page
// block itself carries the title but no body text, so it is excluded from
// `body`; the engine weights `title` above `body` so a title-only match still
// surfaces the page.
//
// The `contentHash` is a sha256 over exactly what the indexed doc encodes —
// title, body, and the emoji icon carried in metadata — so ANY change that
// would alter the stored doc (content edit, title rename, icon swap) changes the
// hash, and nothing else does. This is the skip-if-unchanged signal.
export function derivePageSearchDoc(
  pageId: string,
  pageBlock: { readonly data?: unknown },
  contentBlocks: readonly { type: string; data: unknown }[],
): BuiltPageSearchDoc {
  const data = pageData(pageBlock);
  const title = data.title || "Untitled";
  const body = contentBlocks
    .map((b) => textOf(b))
    .filter((t) => t.length > 0)
    .join("\n");
  const icon = data.icon;

  const contentHash = sha256Hex(JSON.stringify({ title, body, icon }));

  return {
    contentHash,
    doc: {
      source: SOURCE,
      entityId: pageId,
      title,
      body,
      route: "/pages/page/" + pageId,
      metadata: { icon, contentHash },
    },
  };
}
