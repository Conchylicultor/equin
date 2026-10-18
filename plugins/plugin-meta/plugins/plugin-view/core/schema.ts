import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { PluginNode, PluginTreePayload } from "./types";

// Recursive plugin node. `facets` is left loose (z.record of z.unknown) — each
// facet's shape lives in its own `core/` and consumers read `facets[id]` directly
// via a contribution-carried id; modelling every facet here would duplicate those
// types for no parse-safety benefit.
const pluginNodeSchema: ZodParser<PluginNode> = z.lazy(() =>
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
    children: z.array(pluginNodeSchema),
    facets: z.record(z.string(), z.unknown()),
  }),
);

export const pluginTreePayloadSchema: ZodParser<PluginTreePayload> = z.object({
  pluginsRoot: z.string(),
  plugins: z.array(pluginNodeSchema),
  totals: z.object({
    plugins: z.number(),
    loadBearing: z.number(),
    umbrellas: z.number(),
  }),
});
