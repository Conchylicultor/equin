import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * The equin main checkout on this machine (`getMainRepoRoot`), absolute —
 * what the "equin" place opens. Only the server knows where it is, and only
 * the computer has one: served by the machine half, so a host without the
 * computer (the demo) answers unavailable and the place is left out.
 */
export const fileExplorerMainCheckout = liveValue(
  "file-explorer.main-checkout",
  {
    schema: z.string().min(1),
    needsMachine: { feature: "The equin checkout" },
  },
);
