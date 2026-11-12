import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { readToolInput } from "./tool-input";

const input = z.object({ to: z.string(), text: z.string() });
const partialInput = input.partial();

describe("readToolInput", () => {
  test("a finished input the schema reads is ready", () => {
    expect(
      readToolInput({ to: "task-1", text: "hi" }, { input }, false),
    ).toEqual({
      kind: "ready",
      input: { to: "task-1", text: "hi" },
    });
  });

  // report-1794454897-kc95n8: the model called message_agent with the wrong
  // argument names; the tool refused it and the transcript kept it.
  test("a finished input with the wrong fields is invalid, naming them", () => {
    const read = readToolInput(
      { conversation_id: "conv-1", message: "Thanks" },
      { input },
      false,
    );
    expect(read.kind).toBe("invalid");
    if (read.kind !== "invalid") throw new Error("unreachable");
    expect(read.issues).toContain("to:");
    expect(read.issues).toContain("text:");
  });

  // report-1794456880-i9c504: query_db called with `query` instead of `sql`.
  test("a finished input is never read with the partial schema", () => {
    const read = readToolInput({ text: "hi" }, { input, partialInput }, false);
    expect(read.kind).toBe("invalid");
  });

  test("a call being written, with no partial schema, is the bare card", () => {
    expect(readToolInput({ to: "ta" }, { input }, true)).toEqual({
      kind: "writing",
    });
  });

  test("a call being written is read with the partial schema", () => {
    expect(readToolInput({ to: "ta" }, { input, partialInput }, true)).toEqual({
      kind: "ready",
      input: { to: "ta" },
    });
  });

  test("a partial input the partial schema cannot read yet is the bare card", () => {
    expect(readToolInput(undefined, { input, partialInput }, true)).toEqual({
      kind: "writing",
    });
  });
});
