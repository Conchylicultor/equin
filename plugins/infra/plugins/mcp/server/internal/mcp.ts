import type { z } from "zod";
import {
  registeringPlugin,
  type Registration,
} from "@plugins/framework/plugins/server-core/core";
import { registry, scopeRegistry, toolDeclaredIn } from "./registry";

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

/**
 * What the handler of a tool declared `unattached: true` gets: the same, except
 * that `conversationId` is `null` for a session equin did not launch (a
 * `claude` started in a terminal — see `MCP_UNATTACHED_ID`). Such a tool must
 * answer without a conversation: its "own" worktree, deploy or anything else
 * read off the conversation defaults to main.
 */
export interface McpCallerContext {
  conversationId: string | null;
  toolUseId: string | null;
}

export type McpToolResult = {
  content: Array<
    | { type: "text"; text: string }
    /** Base64-encoded image bytes, e.g. a screenshot. */
    | { type: "image"; data: string; mimeType: string }
  >;
};

type McpToolOutcome = Promise<McpToolResult> | McpToolResult;

interface McpToolBase<T extends z.ZodRawShape> {
  name: string;
  /** The fixed text of the tool's description. */
  description: string;
  inputSchema: T;
}

/** A tool only a conversation equin launched sees (the default). */
export interface McpConversationTool<
  T extends z.ZodRawShape = z.ZodRawShape,
> extends McpToolBase<T> {
  unattached?: false;
  /**
   * A LIVE section appended to {@link description} (after a blank line):
   * rendered per request, and only for a request that lists the tools
   * (`tools/list`), so it states the data as of the moment the client listed
   * them — typically once, at connect. For facts an agent needs while using the
   * tool that live in the database (a vocabulary to pick from), where a fixed
   * string would go stale. `null` (or blank) contributes nothing. A render that
   * throws is reported, and the tool is listed with a notice in place of the
   * section — never a silently missing section, never a failed listing.
   */
  liveDescription?: (ctx: McpToolContext) => Promise<string | null>;
  /**
   * Whether this conversation sees the tool. Evaluated on every MCP request
   * (keep it to a cheap lookup); when false the tool is neither listed in
   * `tools/list` nor callable for that request. Omitted: always visible. A
   * `when` that throws is reported and hides only this tool (fail closed).
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
    args: z.output<z.ZodObject<T>>,
    ctx: McpToolCallContext,
  ) => McpToolOutcome;
}

/**
 * A tool also served to a session with no conversation (`MCP_UNATTACHED_ID`) —
 * as well as to every default-scope conversation. It has no `when`, live
 * description or profiles: each of those is a function of a conversation.
 */
export interface McpUnattachedTool<
  T extends z.ZodRawShape = z.ZodRawShape,
> extends McpToolBase<T> {
  unattached: true;
  liveDescription?: never;
  when?: never;
  profiles?: never;
  handler: (
    args: z.output<z.ZodObject<T>>,
    ctx: McpCallerContext,
  ) => McpToolOutcome;
}

export type McpTool<T extends z.ZodRawShape = z.ZodRawShape> =
  McpConversationTool<T> | McpUnattachedTool<T>;

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
 * Returns a {@link Registration} token. The actual `registry.set` (and the
 * duplicate-name guard) fire when the framework invokes `.register()`
 * during the plugin register phase. Plugins list the result in their
 * `register` array on `ServerPluginDefinition`.
 *
 * Overloaded rather than taking the union, so each declaration's handler is
 * typed from its own kind: `unattached: true` makes `ctx.conversationId`
 * `string | null`, anything else keeps it a `string`.
 */
function tool<T extends z.ZodRawShape>(
  decl: McpConversationTool<T>,
): Registration;
function tool<T extends z.ZodRawShape>(
  decl: McpUnattachedTool<T>,
): Registration;
function tool<T extends z.ZodRawShape>(decl: McpTool<T>): Registration {
  return {
    _kind: "mcp-tool",
    _factory: "mcpTool",
    _doc: { label: decl.name, detail: decl.description.split("\n")[0] },
    register() {
      if (registry.has(decl.name)) {
        throw new Error(`MCP tool "${decl.name}" already registered`);
      }
      registry.set(decl.name, decl as unknown as McpTool);
      toolDeclaredIn.set(decl.name, registeringPlugin());
    },
  };
}

export const Mcp = {
  tool,
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
};
