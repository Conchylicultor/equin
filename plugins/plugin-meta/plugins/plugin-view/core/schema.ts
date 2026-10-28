import { z } from "zod";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";
import type { PluginNode, PluginTreePayload } from "./types";

/** The tree is every plugin of this checkout, read whole by every view over it. */
const TREE_REASON =
  "this checkout's plugin tree — one node per plugin (about 1.5k), the code's own structure, read whole by the explorer and Studio";

// Recursive plugin node. `facets` is left loose (z.record of z.unknown) — each
// facet's shape lives in its own `core/` and consumers read `facets[id]` directly
// via a contribution-carried id; modelling every facet here would duplicate those
// types for no parse-safety benefit.
const pluginNodeSchema: z.ZodType<PluginNode> = z.lazy(() =>
  z.object({
    path: z.string(),
    name: z.string(),
    id: z.custom<PluginId>((v) => typeof v === "string"),
    description: z.string().optional(),
    loadBearing: z.boolean(),
    collapsed: z.boolean(),
    runtimes: z.object({
      web: z.boolean(),
      server: z.boolean(),
      machine: z.boolean(),
      central: z.boolean(),
    }),
    children: wholeList(pluginNodeSchema, { reason: TREE_REASON }),
    facets: wholeRecord(z.unknown(), {
      reason: "one entry per facet extractor — a closed set of a few dozen",
    }),
  }),
);

export const pluginTreePayloadSchema: z.ZodType<PluginTreePayload> = z.object({
  pluginsRoot: z.string(),
  plugins: wholeList(pluginNodeSchema, { reason: TREE_REASON }),
  totals: z.object({
    plugins: z.number(),
    loadBearing: z.number(),
    umbrellas: z.number(),
  }),
});
