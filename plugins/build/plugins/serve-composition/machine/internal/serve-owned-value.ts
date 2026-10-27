import { serveValue } from "@plugins/network/plugins/live/machine";
import { serveOwned } from "../../shared/serve-owned";

/**
 * Measured on every ask. The loader is lazy for the same reason the reset and
 * reclaim handlers are: it reaches the reclaim primitive and through it
 * `database/admin`, a graph only a delete needs, so it stays off the boot path.
 */
export const serveOwnedServed = serveValue(serveOwned, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "a marker scan of every namespace on the host, taken when the delete asks — nothing watches the namespaces of every checkout",
    },
  },
  loader: async ({ composition }) => {
    const { ownedNamespacesFor } =
      await import("../../server/internal/reclaim-composition");
    return { namespaces: await ownedNamespacesFor(composition) };
  },
});
