import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/** How many failing contributions the health value names (the rest are counted). */
export const MCP_HEALTH_MAX_DEGRADED = 10;

/** One per-connection contribution whose latest run threw (`runContribution`). */
export const McpDegradedSchema = z.object({
  /** The contribution, as its report names it: `instructions section "tree-digest"`. */
  what: z.string(),
  message: z.string(),
  /** When it last failed (epoch ms). */
  at: z.number(),
});
export type McpDegraded = z.infer<typeof McpDegradedSchema>;

/**
 * This backend's MCP server, as its own requests saw it — every field is an
 * observation of real agent traffic, never a probe.
 *
 * - `requests`: `none` until the first request since boot; then the outcome
 *   of the LATEST one — `ok`, or `failing` with why (it threw, or answered
 *   5xx). A request that answers a JSON-RPC error (an unknown tool) is `ok`:
 *   the server answered.
 * - `degraded`: the contributions whose latest run threw — the connection
 *   still answered, with that tool hidden or that section replaced by a
 *   notice. A contribution leaves the list the next time it runs cleanly.
 */
export const McpHealthSchema = z.object({
  requests: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("ok") }),
    z.object({
      kind: z.literal("failing"),
      message: z.string(),
      /** When the latest request failed (epoch ms). */
      at: z.number(),
    }),
  ]),
  degraded: cappedList(McpDegradedSchema, { max: MCP_HEALTH_MAX_DEGRADED }),
  /** Failing contributions beyond the ones `degraded` names. */
  degradedMore: z.number(),
});
export type McpHealth = z.infer<typeof McpHealthSchema>;

/** The MCP server's health on this backend, pushed when it changes. */
export const mcpHealth = liveValue("mcp.health", { schema: McpHealthSchema });
