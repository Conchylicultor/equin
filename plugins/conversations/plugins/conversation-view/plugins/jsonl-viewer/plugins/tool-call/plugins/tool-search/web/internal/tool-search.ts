import { z } from "zod";
import {
  toolName,
  type ToolCall,
  type ToolName,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";

/** ToolSearch's input, as its card draws it. */
export const ToolSearchInputSchema = z.looseObject({
  query: z.string(),
  max_results: z.number().optional(),
});
export type ToolSearchInput = z.infer<typeof ToolSearchInputSchema>;

/**
 * What one ToolSearch call asked for and got back.
 *
 * `select:a,b` loads named tools directly; any other query is a keyword search
 * ranked by the harness. A select states what it expected, so a name it asked
 * for that did not come back is `missing` — a keyword search expects nothing
 * in particular, so it only has matches.
 */
export type ToolSearch =
  | {
      mode: "select";
      requested: ToolName[];
      /** Undefined while the call is in flight. */
      loaded?: ToolName[];
      missing: ToolName[];
    }
  | {
      mode: "search";
      query: string;
      maxResults?: number;
      /** Undefined while the call is in flight. */
      matches?: ToolName[];
    };

const SELECT_PREFIX = "select:";

export function readToolSearch(
  event: ToolCall,
  input: ToolSearchInput,
): ToolSearch {
  const query = input.query.trim();
  // The result's tool_reference names ARE the loaded tools; a no-match result
  // is text ("No matching deferred tools found") with none.
  const returned = event.result
    ? (event.result.toolReferences ?? []).map(toolName)
    : undefined;

  if (query.startsWith(SELECT_PREFIX)) {
    const requested = query
      .slice(SELECT_PREFIX.length)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(toolName);
    // A select may name a tool by its bare name (`read_page`) and get back
    // its full id, so a request counts as served by either spelling.
    const served = (r: ToolName) =>
      returned?.some((t) => t.id === r.id || t.name === r.id) ?? true;
    return {
      mode: "select",
      requested,
      loaded: returned,
      missing: returned ? requested.filter((r) => !served(r)) : [],
    };
  }
  return {
    mode: "search",
    query,
    maxResults: input.max_results,
    matches: returned,
  };
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
