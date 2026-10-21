import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";

/**
 * One kind of result an agent thread delivers: the MCP tool its agent calls to
 * hand the host a result, and the schema of that call's input. Declared once
 * in the host's `core/`, so both runtimes read the same definition — the
 * server registers the tool with `schema` as its `inputSchema` (a payload that
 * does not parse goes back to the agent as the tool's error), and the web
 * parses an accepted call's input with it to render the host's card.
 *
 * `tool` is the tool's own name (`places_show_picks`), not the name the model
 * calls it by: an MCP tool reaches the transcript as `mcp__<server>__<tool>`,
 * and a thread matches calls by the tool's own name whatever server serves it.
 */
export interface ThreadResultDef<T = unknown> {
  readonly tool: string;
  readonly schema: ZodParser<T>;
  /**
   * How many things one accepted payload delivers — what the thread's header
   * and a host's pill count ("8 picks" from one call holding eight). Default 1.
   */
  // Method syntax: a def of a narrower payload is still a ThreadResultDef.
  count?(payload: T): number;
}

/** Declare a result kind — see {@link ThreadResultDef}. */
export function defineThreadResult<T>(def: {
  tool: string;
  schema: ZodParser<T>;
  count?: (payload: T) => number;
}): ThreadResultDef<T> {
  if (def.tool.startsWith("mcp__")) {
    throw new Error(
      `defineThreadResult: "${def.tool}" is a transcript name — pass the tool's own name (the part after mcp__<server>__)`,
    );
  }
  return {
    tool: def.tool,
    schema: def.schema,
    ...(def.count === undefined ? {} : { count: def.count }),
  };
}

/** The payload type a result kind parses to. */
export type ThreadResultPayload<D> =
  D extends ThreadResultDef<infer T> ? T : never;

/**
 * How many things a turn's results deliver: each accepted payload by its
 * kind's `count` (one when it has none); an invalid result delivers nothing.
 */
export function resultCountOf(
  results: readonly (
    | { kind: "accepted"; def: ThreadResultDef; payload: unknown }
    | { kind: "invalid" }
  )[],
): number {
  let n = 0;
  for (const r of results) {
    if (r.kind !== "accepted") continue;
    n += r.def.count === undefined ? 1 : r.def.count(r.payload);
  }
  return n;
}
