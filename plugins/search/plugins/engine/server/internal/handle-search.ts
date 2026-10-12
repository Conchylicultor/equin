import { implement } from "@plugins/infra/plugins/endpoints/server";
import { searchEndpoint } from "../../core/endpoints";
import { runSearch } from "./run-search";

// The plain HTTP form of the search, kept for the editor-collab e2e script
// (`crdt-adjacent-surfaces-verify.ts`), which asks it over HTTP. The app reads
// the live `search.results` value. `sources` is a comma-joined list here.
export const handleSearch = implement(searchEndpoint, async ({ query }) =>
  runSearch(
    query.q,
    query.sources
      ?.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0) ?? [],
  ),
);
