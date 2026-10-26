import { serveValue } from "@plugins/network/plugins/live/server";
import {
  UG_SEARCH_MAX_RESULTS,
  UG_SEARCH_QUERY_MAX,
  ugSearch,
} from "../../shared/resources";
import { searchUgTabContent } from "./ug-client";

/**
 * The UG catalog search. A classified `UgFetchError` (signature rejected, a
 * changed shape, the network) propagates as a loader failure — loud, and
 * retried by the reader — never as an empty list.
 */
export const ugSearchServed = serveValue(ugSearch, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "a third-party answer to one query (the first page of UG's catalog search): no change signal",
    },
  },
  loader: async ({ q }) => {
    // One tuple per question: an untrimmed query is refused, not trimmed
    // here, so `"x "` and `"x"` cannot be two cached answers to one search.
    if (q !== q.trim() || q.length === 0 || q.length > UG_SEARCH_QUERY_MAX) {
      throw ugSearch.refuse(
        "invalid-query",
        `An Ultimate Guitar search needs a trimmed query of 1–${UG_SEARCH_QUERY_MAX} characters.`,
      );
    }
    return (await searchUgTabContent(q)).slice(0, UG_SEARCH_MAX_RESULTS);
  },
});
