import { serveValue } from "@plugins/network/plugins/live/server";
import { communityCatalog } from "../../shared/resources";
import { loadCatalog } from "./load-catalog";

/** The bundled catalog, served whole (lazily parsed on first read). */
export const communityCatalogServed = serveValue(communityCatalog, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "the catalog is a JSON snapshot bundled with the code: it changes only when the fetch script is re-run and the server redeployed",
    },
  },
  loader: async () => ({ themes: await loadCatalog() }),
});
