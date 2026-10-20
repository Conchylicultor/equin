import { describe, expect, test } from "bun:test";
import { activeLineUuids } from "./branch-filter";

// Line shapes as Claude Code writes them. File order = array order.
const prompt = (uuid: string, parentUuid: string | null) => ({
  type: "user",
  uuid,
  parentUuid,
  message: { role: "user", content: `prompt ${uuid}` },
});
const assistant = (uuid: string, parentUuid: string | null) => ({
  type: "assistant",
  uuid,
  parentUuid,
  message: { role: "assistant", content: [{ type: "text", text: uuid }] },
});
const toolUse = (uuid: string, parentUuid: string | null) => ({
  type: "assistant",
  uuid,
  parentUuid,
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: `tu-${uuid}`, name: "Bash", input: {} }],
  },
});
const toolResult = (uuid: string, parentUuid: string, of: string) => ({
  type: "user",
  uuid,
  parentUuid,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: `tu-${of}`, content: "ok" }],
  },
});
const attachment = (uuid: string, parentUuid: string) => ({
  type: "attachment",
  uuid,
  parentUuid,
  attachment: { type: "hook_success" },
});
const interrupt = (uuid: string, parentUuid: string) => ({
  type: "user",
  uuid,
  parentUuid,
  message: {
    role: "user",
    content: [{ type: "text", text: "[Request interrupted by user]" }],
  },
});

const uuidsOf = (lines: { uuid: string }[]) =>
  new Set(lines.map((l) => l.uuid));

describe("activeLineUuids", () => {
  test("linear chain keeps every line", () => {
    const lines = [prompt("a", null), assistant("b", "a"), prompt("c", "b")];
    expect(activeLineUuids(lines)).toEqual(uuidsOf(lines));
  });

  test("empty / uuid-less input keeps nothing (caller passes those through)", () => {
    expect(activeLineUuids([])).toEqual(new Set());
    expect(activeLineUuids([{ type: "permission-mode" }])).toEqual(new Set());
  });

  test("rewind: the superseded prompt's whole subtree is dropped", () => {
    const lines = [
      prompt("p0", null),
      assistant("a0", "p0"),
      prompt("old", "a0"), // abandoned attempt
      assistant("oldA", "old"),
      attachment("oldAtt", "oldA"), // side leaf of the abandoned branch
      prompt("new", "a0"), // resubmitted — appended later, so it wins
      assistant("newA", "new"),
    ];
    expect(activeLineUuids(lines)).toEqual(
      new Set(["p0", "a0", "new", "newA"]),
    );
  });

  test("the abandoned branch can be longer and newer-looking than the kept one", () => {
    const lines = [
      prompt("p0", null),
      assistant("a0", "p0"),
      prompt("old", "a0"),
      assistant("old1", "old"),
      prompt("old2", "old1"),
      assistant("old3", "old2"),
      prompt("new", "a0"),
    ];
    expect(activeLineUuids(lines)).toEqual(new Set(["p0", "a0", "new"]));
  });

  test("nested rewinds each drop only their own superseded prompts", () => {
    const lines = [
      prompt("p0", null),
      assistant("a0", "p0"),
      prompt("x1", "a0"),
      assistant("x1a", "x1"),
      prompt("y1", "x1a"), // rewound inside x1's branch
      prompt("y2", "x1a"),
      assistant("y2a", "y2"),
      prompt("x2", "a0"), // then the whole x1 branch is rewound
    ];
    expect(activeLineUuids(lines)).toEqual(new Set(["p0", "a0", "x2"]));
  });

  test("parallel tool batch: every call and every result is kept", () => {
    // Claude chains the batch's tool_use lines, parents each result on its
    // own tool_use, and continues the turn from the last result.
    const lines = [
      prompt("p0", null),
      toolUse("t1", "p0"),
      toolUse("t2", "t1"),
      toolUse("t3", "t2"),
      toolResult("r1", "t1", "t1"),
      toolResult("r2", "t2", "t2"),
      toolResult("r3", "t3", "t3"),
      assistant("next", "r3"),
    ];
    expect(activeLineUuids(lines)).toEqual(uuidsOf(lines));
  });

  test("parallel tool batch with results out of order keeps the orphaned call", () => {
    // Result 2 lands first; the turn continues from result 1, which leaves
    // t2 AND r2 off the newest-leaf path — the old rule dropped the call.
    const lines = [
      prompt("p0", null),
      toolUse("t1", "p0"),
      toolUse("t2", "t1"),
      toolResult("r2", "t2", "t2"),
      toolResult("r1", "t1", "t1"),
      assistant("next", "r1"),
    ];
    expect(activeLineUuids(lines)).toEqual(uuidsOf(lines));
  });

  test("a chain of hook attachments off a live node is kept", () => {
    const lines = [
      prompt("p0", null),
      toolUse("t1", "p0"),
      attachment("hook", "t1"),
      attachment("ctx", "hook"),
      toolResult("r1", "t1", "t1"),
      assistant("next", "r1"),
    ];
    expect(activeLineUuids(lines)).toEqual(uuidsOf(lines));
  });

  test("non-prompt user siblings never supersede one another", () => {
    // An interrupt sentinel and a tool result under one parent are not a rewind.
    const lines = [
      prompt("p0", null),
      toolUse("t1", "p0"),
      toolResult("r1", "t1", "t1"),
      interrupt("int", "t1"),
      prompt("p1", "int"),
    ];
    expect(activeLineUuids(lines)).toEqual(uuidsOf(lines));
  });

  test("multiple disjoint roots (resume / compaction) are all kept", () => {
    const lines = [
      prompt("r1", null),
      assistant("r1b", "r1"),
      prompt("r2", null),
      assistant("r2b", "r2"),
    ];
    expect(activeLineUuids(lines)).toEqual(uuidsOf(lines));
  });

  test("a rewind inside a later segment only prunes that segment", () => {
    const lines = [
      prompt("r1", null),
      assistant("r1b", "r1"),
      assistant("r2", null),
      prompt("x1", "r2"), // abandoned in segment 2
      prompt("x2", "r2"), // kept in segment 2
    ];
    expect(activeLineUuids(lines)).toEqual(new Set(["r1", "r1b", "r2", "x2"]));
  });

  test("dangling parent (ref into a prior transcript) is kept", () => {
    const lines = [prompt("a", "not-in-file"), assistant("b", "a")];
    expect(activeLineUuids(lines)).toEqual(new Set(["a", "b"]));
  });

  test("a cyclic chain cannot loop forever", () => {
    const lines = [
      prompt("a", "c"),
      prompt("b", "c"), // supersedes a; a's subtree walks back into the cycle
      assistant("c", "a"),
    ];
    // Malformed input: only termination is asserted. The whole cycle sits
    // under the superseded `a`, so it all goes.
    expect(activeLineUuids(lines)).toEqual(new Set());
  });
});
