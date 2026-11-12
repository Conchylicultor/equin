import type { z } from "zod";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

export type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;

/**
 * A tool call as its renderer is handed it: everything the transcript holds
 * about the call but its raw input. The input reaches a renderer only parsed,
 * as `ToolViewProps.input` — so no renderer can read fields the model may not
 * have written (a call it got wrong, one still being written).
 */
export type ToolCall = Omit<ToolCallEvent, "input">;

/** What a tool's renderer draws from: the call, and its input as parsed by the renderer's own schema. */
export interface ToolViewProps<I> {
  event: ToolCall;
  input: I;
}

/**
 * The schemas a renderer reads a call's input with: `input` for a finished
 * call; `partialInput` (optional) for one the model is still writing — any
 * field may be missing yet, a string may stop mid-way — so the card fills in
 * as it is written.
 */
export interface ToolInputSchemas<I, P> {
  input: z.ZodType<I>;
  partialInput?: z.ZodType<P>;
}

/**
 * A call's input, read for its renderer:
 * - `ready`: the input as the renderer's schema reads it;
 * - `writing`: the model is still writing it and the renderer draws no partial
 *   input (or what is written so far does not read yet) — the bare card;
 * - `invalid`: the finished input is not what the renderer draws — a call the
 *   model got wrong (the tool refused it, and the transcript keeps it), or a
 *   tool whose input changed since. Drawn by the generic card, which shows the
 *   input as it is, with what did not match.
 */
export type ToolInputRead<T> =
  | { kind: "ready"; input: T }
  | { kind: "writing" }
  | { kind: "invalid"; issues: string };

/** `zod`'s issues as one line per issue: `path: message`. */
function issuesText(error: z.ZodError): string {
  return error.issues
    .map((i) =>
      i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
    )
    .join("\n");
}

/**
 * Read `raw` (a call's input) with a renderer's schemas. `writing`: the model
 * is still writing it. A finished input is read with `input`, never with
 * `partialInput`, so a renderer draws a finished call only from an input it
 * fully understands.
 */
export function readToolInput<I extends P, P>(
  raw: unknown,
  schemas: ToolInputSchemas<I, P>,
  writing: boolean,
): ToolInputRead<P> {
  if (writing) {
    if (!schemas.partialInput) return { kind: "writing" };
    const partial = schemas.partialInput.safeParse(raw);
    return partial.success
      ? { kind: "ready", input: partial.data }
      : { kind: "writing" };
  }
  const read = schemas.input.safeParse(raw);
  return read.success
    ? { kind: "ready", input: read.data }
    : { kind: "invalid", issues: issuesText(read.error) };
}
