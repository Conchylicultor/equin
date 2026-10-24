import { z } from "zod";
import { wholeRecord } from "@plugins/packages/plugins/list-bound/core";

// A search result is one navigable hit: the source that owns it, the entity id
// within that source, a display title, a highlighted snippet (server-produced
// via ts_headline; `<mark>…</mark>` spans mark the matched terms), the route to
// open it, and an opaque per-source metadata bag (e.g. an icon descriptor).
export const SearchResultSchema = z.object({
  source: z.string(),
  entityId: z.string(),
  title: z.string(),
  snippet: z.string(),
  route: z.string(),
  metadata: wholeRecord(z.unknown(), {
    reason:
      "one source's opaque metadata bag — a few keys (an icon descriptor)",
  }).nullable(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

// The upsert shape a consumer feeds into the index for one navigable entity.
// `title` is weighted above `body` for ranking; `route` is where selecting the
// result navigates; `metadata` is an opaque per-source bag round-tripped to the
// result (defaults to `{}` in the table).
export const SearchDocSchema = z.object({
  source: z.string(),
  entityId: z.string(),
  title: z.string(),
  body: z.string(),
  route: z.string(),
  metadata: z.record(z.unknown()).optional(),
});
export type SearchDoc = z.infer<typeof SearchDocSchema>;
