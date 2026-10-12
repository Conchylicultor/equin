import { serveValue } from "@plugins/network/plugins/live/server";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
import { fileExplorerMainCheckout } from "../../shared/resources";

// External: the truth is git (`--git-common-dir`), which nothing here
// observes — and the main checkout a process belongs to does not move while it
// runs, so the value is `fixed`.
export const mainCheckoutServed = serveValue(fileExplorerMainCheckout, {
  source: "external",
  changes: {
    fixed: { reason: "the main checkout path is fixed for the process" },
  },
  loader: () => getMainRepoRoot(),
});
