import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { SearchResultSchema } from "./schemas";

/** The longest query `searchResults` answers; a reader clamps to it. */
export const SEARCH_QUERY_MAX = 200;

/**
 * One full-text search question: `q` is the raw user query (word + prefix
 * matched server-side); `sources` scopes it to those source ids (omit to
 * search every source).
 */
export const SearchQuerySchema = z.object({
  q: z.string().min(1).max(SEARCH_QUERY_MAX),
  sources: z.array(z.string().min(1)).optional(),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/**
 * Ranked full-text search across indexed documents, as a typed-query live
 * value: one tuple per question, the 30 best hits. Served `db` over
 * `search_documents`, so a reindex (a page edited, renamed or deleted while
 * the quick-find dialog is open) re-ranks the open question in place.
 */
export const searchResults = liveValue("search.results", {
  schema: z.array(SearchResultSchema),
  query: SearchQuerySchema,
});
