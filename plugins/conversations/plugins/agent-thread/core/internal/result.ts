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
 *
 * `O` is what the tool hands back (see `output`); `undefined` for a kind
 * declaring none.
 */
export interface ThreadResultDef<T = unknown, O = unknown> {
  readonly tool: string;
  readonly schema: ZodParser<T>;
  /**
   * Whether one turn keeps every accepted call of this kind (`true`: each is
   * its own result — tasks filed) or only the last (`false`, the default: a
   * later call replaces the earlier one, at its own position — a revised set
   * of picks).
   */
  readonly multiple: boolean;
  /**
   * The schema of what the tool hands back — the call's OUTPUT, read off its
   * result in the transcript (written by {@link threadResultReply}), when the
   * host's card needs something only the tool knows (the id of what it
   * created). Absent: the result carries no output.
   */
  readonly output?: ZodParser<O>;
  /**
   * How many things one accepted payload delivers — what the thread's header
   * and a host's pill count ("8 picks" from one call holding eight). Default 1.
   */
  // Method syntax: a def of a narrower payload is still a ThreadResultDef.
  count?(payload: T): number;
}

interface ThreadResultDecl<T> {
  tool: string;
  schema: ZodParser<T>;
  /** See {@link ThreadResultDef.multiple}; default false. */
  multiple?: boolean;
  count?: (payload: T) => number;
}

/** Declare a result kind — see {@link ThreadResultDef}. */
export function defineThreadResult<T, O>(
  def: ThreadResultDecl<T> & { output: ZodParser<O> },
): ThreadResultDef<T, O> & { readonly output: ZodParser<O> };
export function defineThreadResult<T>(
  def: ThreadResultDecl<T> & { output?: undefined },
): ThreadResultDef<T, undefined>;
export function defineThreadResult<T, O>(
  def: ThreadResultDecl<T> & { output?: ZodParser<O> },
): ThreadResultDef<T, O | undefined> {
  if (def.tool.startsWith("mcp__")) {
    throw new Error(
      `defineThreadResult: "${def.tool}" is a transcript name — pass the tool's own name (the part after mcp__<server>__)`,
    );
  }
  return {
    tool: def.tool,
    schema: def.schema,
    multiple: def.multiple ?? false,
    ...(def.output === undefined ? {} : { output: def.output }),
    ...(def.count === undefined ? {} : { count: def.count }),
  };
}

/** The payload type a result kind parses to. */
export type ThreadResultPayload<D> =
  D extends ThreadResultDef<infer T, unknown> ? T : never;

/** The output type a result kind's tool hands back (`undefined`: none). */
export type ThreadResultOutput<D> =
  D extends ThreadResultDef<unknown, infer O> ? O : never;

/**
 * The tool's reply for a kind that declares an `output`: the output as the
 * result's one text block, JSON — the encoding `groupThread` reads back, so a
 * handler never spells it. The output is checked against the kind's schema
 * here (a reply the thread could not read back throws, in the handler), so
 * the schema must survive a JSON round trip (plain data, no transforms).
 * Shaped as an MCP tool result: a handler returns it as is.
 */
export function threadResultReply<O>(
  def: { readonly tool: string; readonly output: ZodParser<O> },
  output: O,
): { content: { type: "text"; text: string }[] } {
  const checked = def.output.safeParse(output);
  if (!checked.success) {
    throw new Error(
      `threadResultReply: the ${def.tool} output does not parse under its schema: ${checked.error.message}`,
    );
  }
  return { content: [{ type: "text", text: JSON.stringify(output) }] };
}

/**
 * Read a result's output back from the text `threadResultReply` wrote: the
 * output, or why it cannot be read (not JSON, or not the schema's shape).
 */
export function parseThreadResultOutput<O>(
  schema: ZodParser<O>,
  content: string,
): { ok: true; output: O } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { ok: false, error: `output is not JSON: ${err.message}` };
    }
    throw err;
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, output: parsed.data }
    : { ok: false, error: `output: ${parsed.error.message}` };
}

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
