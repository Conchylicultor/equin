import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";

/**
 * One registered `Mcp.tool`, as the catalog describes it. Everything here is
 * what the declaration states; nothing is evaluated for a conversation — a
 * `when` gate and a live description are per-conversation, so the catalog only
 * says that the tool has one.
 */
export const McpCatalogToolSchema = z.object({
  name: z.string(),
  /** The plugin whose `register` array held the token; `null` when it was
   * registered outside the register phase. */
  declaredIn: z.string().nullable(),
  /** The fixed description (a live section, when declared, is appended to it
   * at `tools/list`). */
  description: z.string(),
  hasLiveDescription: z.boolean(),
  /** Gated per conversation by its own `when`. */
  gated: z.boolean(),
  /** The scratch profiles it is reserved for; `null` for a default-scope
   * tool. */
  profiles: wholeList(z.string(), {
    reason: "the scratch profiles a tool is reserved for — one or two",
  }).nullable(),
  /** The input schema exactly as `tools/list` sends it (JSON Schema). */
  inputSchema: wholeRecord(z.unknown(), {
    reason:
      "one JSON Schema object's top-level keywords (type, properties, required, …) — a handful",
  }),
});
export type McpCatalogTool = z.infer<typeof McpCatalogToolSchema>;

/** One `Mcp.instructions` section. Its text is rendered per conversation at
 * `initialize`, so only its identity is catalogued. */
export const McpCatalogInstructionsSchema = z.object({
  id: z.string(),
  declaredIn: z.string().nullable(),
});
export type McpCatalogInstructions = z.infer<
  typeof McpCatalogInstructionsSchema
>;

export const McpCatalogSchema = z.object({
  tools: wholeList(McpCatalogToolSchema, {
    reason:
      "every Mcp.tool the code registers — fixed for the process, a hundred or so",
  }),
  instructions: wholeList(McpCatalogInstructionsSchema, {
    reason:
      "every Mcp.instructions section the code registers — fixed for the process, a handful",
  }),
  /** The one `Mcp.scope` resolver, when a plugin registered it. */
  scope: z.object({ declaredIn: z.string().nullable() }).nullable(),
});
export type McpCatalog = z.infer<typeof McpCatalogSchema>;

/**
 * Everything this backend's MCP server hosts: every tool, instructions section
 * and the scope resolver, with the plugin that declared each. Fixed for the
 * process — contributions only register at boot.
 */
export const mcpCatalog = liveValue("mcp.catalog", {
  schema: McpCatalogSchema,
});

/** The name the MCP server announces itself under at `initialize`. */
export const MCP_SERVER_NAME = "equin";

/** The name an agent sees a tool under: Claude Code prefixes the server's. */
export function agentToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}
