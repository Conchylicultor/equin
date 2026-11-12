import { describe, expect, test } from "bun:test";
import { formatLastStep, lastStepOfLines } from "./last-step";

const assistant = (content: unknown[]) => ({
  type: "assistant",
  uuid: crypto.randomUUID(),
  message: { role: "assistant", content },
});
const user = (content: unknown[]) => ({
  type: "user",
  uuid: crypto.randomUUID(),
  message: { role: "user", content },
});

const toolUse = (name: string, input: unknown, id = "tu_1") => ({
  type: "tool_use",
  id,
  name,
  input,
});
const toolResult = (text: string, id = "tu_1") => ({
  type: "tool_result",
  tool_use_id: id,
  content: text,
});

describe("lastStepOfLines", () => {
  test("a trailing tool_result defers to the call it answers", () => {
    // The bug this pins: a result always lands right after its call, so at any
    // live moment the newest line is a result about a third of the time — and a
    // result's text is the file that was read. The card used to quote it:
    // "Result: 1 # row-actions 2 3 ## What this plugin owns…".
    const step = lastStepOfLines([
      assistant([
        toolUse("Read", { file_path: "/repo/row-actions/CLAUDE.md" }),
      ]),
      user([toolResult("1\t# row-actions\n2\t\n3\t## What this plugin owns")]),
    ]);
    expect(step).toEqual({
      kind: "tool",
      toolName: "Read",
      preview: "CLAUDE.md",
    });
    expect(formatLastStep(step!)).toBe("Read CLAUDE.md");
  });

  test("the call is found past the bookkeeping lines between them", () => {
    const step = lastStepOfLines([
      assistant([toolUse("Bash", { command: "rg -n isSidechain" })]),
      { type: "attachment", uuid: "x", attachment: {} },
      user([toolResult("plugins/foo.ts:12: isSidechain")]),
      { type: "attachment", uuid: "y", attachment: {} },
    ]);
    expect(step).toEqual({
      kind: "tool",
      toolName: "Bash",
      preview: "rg -n isSidechain",
    });
  });

  test("a call's human-readable description wins over its raw command", () => {
    const step = lastStepOfLines([
      assistant([
        toolUse("Bash", {
          command: "./equin await build; echo EXIT=$?",
          description: "Wait for the build verdict",
        }),
      ]),
    ]);
    expect(formatLastStep(step!)).toBe("Bash Wait for the build verdict");
  });

  test("a result whose call has scrolled out of the window says so, and quotes nothing", () => {
    // 8 of 348 measured windows. `null` would render "Starting…", which is false
    // for a sub-agent plainly mid-tool-loop; the payload is what we refuse to show.
    const step = lastStepOfLines([user([toolResult("a enormous payload")])]);
    expect(step).toEqual({ kind: "tool-result" });
    expect(formatLastStep(step!)).toBe("Finished a tool call");
  });

  test("text still wins outright when the sub-agent spoke most recently", () => {
    const step = lastStepOfLines([
      assistant([toolUse("Read", { file_path: "/a/b.ts" })]),
      user([toolResult("contents")]),
      assistant([
        { type: "text", text: "That confirms the parser is shared." },
      ]),
    ]);
    expect(step).toEqual({
      kind: "text",
      preview: "That confirms the parser is shared.",
    });
  });

  test("text OLDER than a trailing result is not reported as the current step", () => {
    // It would mean quoting something the sub-agent said before the step it has
    // since taken. The call it answers is the honest reading.
    const step = lastStepOfLines([
      assistant([{ type: "text", text: "Let me look at the watcher." }]),
      assistant([toolUse("Read", { file_path: "/x/watcher.ts" })]),
      user([toolResult("…")]),
    ]);
    expect(step).toEqual({
      kind: "tool",
      toolName: "Read",
      preview: "watcher.ts",
    });
  });

  test("with parallel calls in flight, the most recent one is what it is doing", () => {
    const step = lastStepOfLines([
      assistant([toolUse("Read", { file_path: "/a.ts" }, "tu_a")]),
      assistant([toolUse("Grep", { pattern: "isSidechain" }, "tu_b")]),
      user([toolResult("…", "tu_a")]),
    ]);
    expect(step).toEqual({
      kind: "tool",
      toolName: "Grep",
      preview: "isSidechain",
    });
  });

  test("an empty window has no step, which is not the same as having done nothing", () => {
    expect(lastStepOfLines([])).toBeNull();
    expect(lastStepOfLines([{ type: "system", uuid: "s" }])).toBeNull();
  });
});
