import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type {
  Edge,
  SerializedEdgeGraph,
  UsageRule,
} from "@plugins/plugin-meta/plugins/closure/core";
import { KEY_SPACES } from "@plugins/framework/plugins/slot-declaration/core";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";

// PluginId is a branded string; over the wire it is just a string. Like the plugin
// tree's schema in plugin-view, we validate shape (string) not brand.
const pluginIdSchema = z.custom<PluginId>((v) => typeof v === "string");

// The value is the whole plugin graph of this checkout on purpose: the closure
// engine runs over all of it client-side, so no list here can be paged.
const GRAPH_REASON =
  "the plugin graph of this checkout — one entry per plugin (about 1.5k) and per edge between two, which the closure engine walks whole client-side";
const idList = wholeList(pluginIdSchema, { reason: GRAPH_REASON });
const adjacency = wholeRecord(idList, { reason: GRAPH_REASON });

const edgeSchema: z.ZodType<Edge> = z.object({
  from: pluginIdSchema,
  to: pluginIdSchema,
  kind: z.union([z.literal("hard"), z.literal("soft")]),
});

const usageRuleSchema: z.ZodType<UsageRule> = z.object({
  then: pluginIdSchema,
  owner: pluginIdSchema,
  users: idList,
  space: z.enum(KEY_SPACES),
  key: z.string(),
});

const serializedEdgeGraphSchema: z.ZodType<SerializedEdgeGraph> = z.object({
  hardForward: adjacency,
  hardReverse: adjacency,
  softForward: adjacency,
  softReverse: adjacency,
  subtree: adjacency,
  edges: wholeList(edgeSchema, { reason: GRAPH_REASON }),
  rules: wholeList(usageRuleSchema, { reason: GRAPH_REASON }),
});

export interface CompositionData {
  graph: SerializedEdgeGraph;
  allIds: PluginId[];
}

const compositionDataSchema: z.ZodType<CompositionData> = z.object({
  graph: serializedEdgeGraphSchema,
  allIds: idList,
});

/**
 * The code-derived structure Studio needs to run the closure engine
 * client-side: the classified {@link SerializedEdgeGraph} and the full set of
 * plugin ids. Derived from plugin-tree's faceted build of `plugins/` (an
 * expensive tree build, cached there), so it is read on demand and told to read
 * again when the plugins folder changes. Composition **manifests** are user
 * data and live in the `compositions` config_v2 config — read client-side, not
 * in this value.
 *
 * Membership answers are deliberately absent from the payload, including "which
 * plugins are not in the app". They are a pure function of this graph plus those
 * manifests, both of which the client holds, so a wire field would be a second
 * spelling of the same answer that can drift from the one the engine computes.
 */
export const compositionData = liveValue("composition.data", {
  schema: compositionDataSchema,
  load: "on-demand",
});
