import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { searchEndpoint } from "../core/endpoints";
import { handleSearch } from "./internal/handle-search";
import { searchResultsServed } from "./internal/resources";

export {
  upsertSearchDocs,
  deleteSearchDocs,
  deleteSource,
  getSourceDocMetadata,
} from "./internal/index-api";

export default {
  description:
    "Domain-agnostic indexed full-text search substrate: search_documents table (tsvector GIN), generic index API, the live search.results typed-query value, and the GET /api/search endpoint.",
  contributions: [...searchResultsServed.declare],
  httpRoutes: {
    [searchEndpoint.route]: handleSearch,
  },
} satisfies ServerPluginDefinition;
