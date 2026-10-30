import { implement } from "@plugins/infra/plugins/endpoints/server";
import { listPages } from "../../core";
import { PageRowSchema } from "../../core";
import { loadPages } from "./resources";

// The live pages ordered by `(page_id, doc_rank)` — a plain select of the
// column the structural-write chokepoint maintains, which the live `pagesTree`
// set serves too, so this HTTP read and the pushed rows can never disagree
// about a page's place. It once ran its own `ORDER BY rank`, a
// second (and wrong) definition of page order: `rank` is comparable only within
// one `(parent_id, rank)` space, while a page's sidebar siblings can span
// several. One concept, one column.
export const handleListPages = implement(listPages, async () => {
  const rows = await loadPages();
  return rows.map((r) => PageRowSchema.parse(r));
});
