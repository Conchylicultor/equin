import type { z } from "zod";
import {
  registeringPlugin,
  type Registration,
} from "@plugins/framework/plugins/server-core/core";
import {
  instructionsDeclaredIn,
  instructionsRegistry,
  registry,
  scopeRegistry,
  toolDeclaredIn,
} from "./registry";

export interface McpToolContext {
  conversationId: string;
}

/**
 * What a tool's handler gets: the conversation, plus the id of the agent's
 * tool call this request answers — the transcript row the call renders as, so
 * a tool can file what it produced under it. Claude Code sends it in the
 * request's `_meta` (`claudecode/toolUseId`); `null` when the client did not.
 */
export interface McpToolCallContext extends McpToolContext {
  toolUseId: string | null;
}

export type McpToolResult = {
  content: Array<
    | { type: "text"; text: string }
    /** Base64-encoded image bytes, e.g. a screenshot. */
    | { type: "image"; data: string; mimeType: string }
  >;
};

export interface McpTool<T extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  /** The fixed text of the tool's description. */
  description: string;
  /**
   * A LIVE section appended to {@link description} (after a blank line):
   * rendered per request, and only for a request that lists the tools
   * (`tools/list`), so it states the data as of the moment the client listed
   * them — typically once, at connect. For facts an agent needs while using the
   * tool that live in the database (a vocabulary to pick from), where a fixed
   * string would go stale. `null` (or blank) contributes nothing. A render that
   * throws fails the listing — loud, never a silently missing section.
   */
  liveDescription?: (ctx: McpToolContext) => Promise<string | null>;
  inputSchema: T;
  /**
   * Whether this conversation sees the tool. Evaluated on every MCP request
   * (keep it to a cheap lookup); when false the tool is neither listed in
   * `tools/list` nor callable for that request. Omitted: always visible. A
   * `when` that throws fails the request.
   */
  when?: (ctx: McpToolContext) => boolean | Promise<boolean>;
  /**
   * The scopes (scratch profiles, see {@link McpScope}) this tool is visible
   * to — and ONLY those: a tool declaring `profiles` is never listed for a
   * conversation in the default scope, and is listed for a profile only when
   * that profile also names it among its tools. Omitted: a default-scope tool.
   */
  profiles?: readonly string[];
  handler: (
    args: z.objectOutputType<T, z.ZodTypeAny>,
    ctx: McpToolCallContext,
  ) => Promise<McpToolResult> | McpToolResult;
}

/**
 * Which tools a conversation may see before any tool's own `when`:
 * - `default` — every tool that declares no `profiles`;
 * - `profile` — exactly `tools` (a scratch profile's allowlist), each of which
 *   must exist and, when it declares `profiles`, name this one.
 */
export type McpScope =
  | { kind: "default" }
  | { kind: "profile"; profile: string; tools: readonly string[] };

/**
 * Resolves a conversation's {@link McpScope}. One per server (registered by
 * the plugin that knows what a conversation runs in); with none, every
 * conversation is in the default scope.
 */
export type McpScopeResolver = (ctx: McpToolContext) => Promise<McpScope>;

/**
 * A section of the server-level instructions an MCP client receives once, in
 * the `initialize` result, at connect. Rendered per connection with the
 * connecting conversation's context; return `null` to contribute nothing for
 * that conversation. A render that throws fails the `initialize` request.
 */
export interface McpInstructions {
  /** Unique id. Sections are joined in id order. */
  id: string;
  render: (ctx: McpToolContext) => Promise<string | null>;
}

export const Mcp = {
  /**
   * Returns a {@link Registration} token. The actual `registry.set` (and the
   * duplicate-name guard) fire when the framework invokes `.register()`
   * during the plugin register phase. Plugins list the result in their
   * `register` array on `ServerPluginDefinition`.
   */
  tool<T extends z.ZodRawShape>(tool: McpTool<T>): Registration {
    return {
      _kind: "mcp-tool",
      _factory: "mcpTool",
      _doc: { label: tool.name, detail: tool.description.split("\n")[0] },
      register() {
        if (registry.has(tool.name)) {
          throw new Error(`MCP tool "${tool.name}" already registered`);
        }
        registry.set(tool.name, tool as unknown as McpTool);
        toolDeclaredIn.set(tool.name, registeringPlugin());
      },
    };
  },
  /**
   * Registers THE scope resolver ({@link McpScopeResolver}). Returns a
   * {@link Registration} token; a second resolver throws at register time.
   */
  scope(resolver: McpScopeResolver): Registration {
    return {
      _kind: "mcp-scope",
      _factory: "mcpScope",
      _doc: { label: "scope" },
      register() {
        if (scopeRegistry.resolver) {
          throw new Error("MCP scope resolver already registered");
        }
        scopeRegistry.resolver = resolver;
        scopeRegistry.declaredIn = registeringPlugin();
      },
    };
  },
  /**
   * Contributes a section to the MCP server instructions sent at `initialize`.
   * Returns a {@link Registration} token; list it in the plugin's `register`
   * array. Duplicate ids throw at register time.
   */
  instructions(instructions: McpInstructions): Registration {
    return {
      _kind: "mcp-instructions",
      _factory: "mcpInstructions",
      _doc: { label: instructions.id },
      register() {
        if (instructionsRegistry.has(instructions.id)) {
          throw new Error(
            `MCP instructions "${instructions.id}" already registered`,
          );
        }
        instructionsRegistry.set(instructions.id, instructions);
        instructionsDeclaredIn.set(instructions.id, registeringPlugin());
      },
    };
  },
};
