import { serveValue } from "@plugins/network/plugins/live/server";
import { searchResults } from "../../core/live";
import { runSearch } from "./run-search";

// One search question's ranked hits. The loader reads `search_documents`, so a
// reindex — upserts and deletes from every source's indexer — recomputes the
// open questions. Throttled: an indexer can write in bursts (a page's text
// projection reindexes as it is typed), and a re-rank once a second is plenty
// for a type-ahead list.
export const searchResultsServed = serveValue(searchResults, {
  source: "db",
  throttleMs: 1000,
  unbounded: {
    reason: "the 30 best-ranked hits of one question (LIMIT 30 in the search)",
  },
  loader: ({ q, sources }) => runSearch(q, sources ?? []),
});
