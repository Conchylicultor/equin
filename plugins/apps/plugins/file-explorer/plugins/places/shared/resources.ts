import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * The equin main checkout on this machine (`getMainRepoRoot`), absolute —
 * what the "equin" place opens. Only the server knows where it is.
 */
export const fileExplorerMainCheckout = liveValue(
  "file-explorer.main-checkout",
  { schema: z.string().min(1) },
);
