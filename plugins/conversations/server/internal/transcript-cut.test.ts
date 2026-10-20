import { describe, expect, test } from "bun:test";
import { cutTranscriptAt } from "./transcript-cut";

// Transcript lines shaped like Claude Code's: a uuid/parentUuid chain, with
// uuid-less bookkeeping lines interleaved.
let n = 0;
const at = () => new Date(1_700_000_000_000 + n++ * 1000).toISOString();
const user = (
  uuid: string,
  parentUuid: string | null,
  text: string,
  extra: object = {},
) => ({
  type: "user",
  uuid,
  parentUuid,
  timestamp: at(),
  message: { role: "user", content: text },
  ...extra,
});
const assistant = (uuid: string, parentUuid: string, text: string) => ({
  type: "assistant",
  uuid,
  parentUuid,
  timestamp: at(),
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const launch = (
  uuid: string,
  parentUuid: string,
  toolUseId: string,
  description: string,
) => ({
  type: "assistant",
  uuid,
  parentUuid,
  timestamp: at(),
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: toolUseId,
        name: "Agent",
        input: { description },
      },
    ],
  },
});
const receipt = (uuid: string, parentUuid: string, toolUseId: string) => ({
  type: "user",
  uuid,
  parentUuid,
  timestamp: at(),
  toolUseResult: { isAsync: true, status: "async_launched" },
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: "Async agent launched",
      },
    ],
  },
});
const notification = (toolUseId: string) =>
  `<task-notification>\n<task-id>t</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>`;
const report = (uuid: string, parentUuid: string, toolUseId: string) =>
  user(uuid, parentUuid, notification(toolUseId), {
    origin: { kind: "task-notification" },
  });

const lines = (objs: object[]) => objs.map((o) => JSON.stringify(o));
const label = (line: string) => {
  const obj = JSON.parse(line) as { uuid?: string; type: string };
  return obj.uuid ?? `(${obj.type})`;
};
const labelsOf = (kept: string[]) => kept.map(label);

describe("cutTranscriptAt", () => {
  test("keeps everything before the chosen message and hands its text back", () => {
    const cut = cutTranscriptAt(
      lines([
        user("u1", null, "first"),
        assistant("a1", "u1", "one"),
        { type: "file-history-snapshot" },
        user("u2", "a1", "second"),
        assistant("a2", "u2", "two"),
        user("u3", "a2", "third"),
      ]),
      "u2",
    );
    if (!cut.ok) throw new Error(cut.reason);
    expect(labelsOf(cut.keptLines)).toEqual([
      "u1",
      "a1",
      "(file-history-snapshot)",
    ]);
    expect(cut.messageText).toBe("second");
    expect(cut.losses).toEqual({
      laterUserTurns: 1,
      lostReports: [],
      unreported: [],
    });
  });

  test("refuses an unknown uuid", () => {
    expect(cutTranscriptAt(lines([user("u1", null, "first")]), "nope")).toEqual(
      {
        ok: false,
        reason: "not-found",
      },
    );
  });

  test("refuses the first message: nothing would be left to resume", () => {
    expect(
      cutTranscriptAt(
        lines([
          { type: "ai-title" },
          user("u1", null, "first"),
          assistant("a1", "u1", "one"),
        ]),
        "u1",
      ),
    ).toEqual({ ok: false, reason: "nothing-before" });
  });

  test("refuses anything that is not the user's own live message", () => {
    const transcript = lines([
      user("u1", null, "first"),
      assistant("a1", "u1", "one"),
      user("u2", "a1", "abandoned"),
      assistant("a2", "u2", "abandoned answer"),
      user("u2b", "a1", "kept instead"),
      assistant("a2b", "u2b", "kept answer"),
      user("m1", "a2b", "Continue", { isMeta: true }),
      receipt("r1", "m1", "toolu_x"),
    ]);
    for (const uuid of ["a1", "u2", "m1", "r1"]) {
      expect(cutTranscriptAt(transcript, uuid)).toEqual({
        ok: false,
        reason: "not-a-live-user-prompt",
      });
    }
  });

  test("an abandoned attempt written after the kept path does not become the conversation", () => {
    // Native /rewind: u2/a2 were abandoned for u2b. Cutting at u2b would leave
    // a2 as the newest leaf in the file — drop the abandoned attempt.
    const cut = cutTranscriptAt(
      lines([
        user("u1", null, "first"),
        assistant("a1", "u1", "one"),
        user("u2", "a1", "abandoned"),
        assistant("a2", "u2", "abandoned answer"),
        user("u2b", "a1", "kept instead"),
        assistant("a2b", "u2b", "kept answer"),
      ]),
      "u2b",
    );
    if (!cut.ok) throw new Error(cut.reason);
    expect(labelsOf(cut.keptLines)).toEqual(["u1", "a1"]);
  });

  test("an earlier abandoned attempt, and side notes off the kept path, stay", () => {
    const cut = cutTranscriptAt(
      lines([
        user("u1", null, "first"),
        user("u1x", null, "never mind"), // abandoned, but BEFORE the last kept ancestor
        assistant("a1", "u1", "one"),
        { type: "attachment", uuid: "att", parentUuid: "a1", timestamp: at() },
        { type: "system", uuid: "sys", parentUuid: "a1", timestamp: at() },
        user("u2", "a1", "second"),
      ]),
      "u2",
    );
    if (!cut.ok) throw new Error(cut.reason);
    expect(labelsOf(cut.keptLines)).toEqual(["u1", "u1x", "a1", "att", "sys"]);
  });

  test("the removed prompt's own queue bookkeeping goes with it", () => {
    const cut = cutTranscriptAt(
      lines([
        user("u1", null, "first"),
        assistant("a1", "u1", "one"),
        {
          type: "queue-operation",
          operation: "enqueue",
          content: "second",
          timestamp: at(),
        },
        { type: "queue-operation", operation: "dequeue", timestamp: at() },
        user("u2", "a1", "second"),
      ]),
      "u2",
    );
    if (!cut.ok) throw new Error(cut.reason);
    expect(labelsOf(cut.keptLines)).toEqual(["u1", "a1"]);
  });

  test("the kept file ends with an empty queue; settled entries stay", () => {
    const cut = cutTranscriptAt(
      lines([
        user("u1", null, "first"),
        {
          type: "queue-operation",
          operation: "enqueue",
          content: "settled",
          timestamp: at(),
        },
        { type: "queue-operation", operation: "dequeue", timestamp: at() },
        {
          type: "queue-operation",
          operation: "enqueue",
          content: notification("toolu_x"),
          timestamp: at(),
        },
        assistant("a1", "u1", "one"),
        user("u2", "a1", "second"),
        { type: "queue-operation", operation: "dequeue", timestamp: at() },
      ]),
      "u2",
    );
    if (!cut.ok) throw new Error(cut.reason);
    expect(
      cut.keptLines.map(
        (l) => (JSON.parse(l) as { content?: string }).content ?? null,
      ),
    ).toEqual([
      null, // u1
      "settled",
      null, // its dequeue
      null, // a1
    ]);
  });

  test("a report delivered after the cut is lost; work that never reported is named", () => {
    const transcript = lines([
      user("u1", null, "launch two agents"),
      launch("l1", "u1", "toolu_a", "Agent A"),
      receipt("r1", "l1", "toolu_a"),
      launch("l2", "r1", "toolu_b", "Agent B"),
      receipt("r2", "l2", "toolu_b"),
      assistant("a1", "r2", "waiting"),
      user("u2", "a1", "meanwhile"),
      assistant("a2", "u2", "4"),
      report("n1", "a2", "toolu_a"),
      assistant("a3", "n1", "A reported"),
    ]);
    const cut = cutTranscriptAt(transcript, "u2");
    if (!cut.ok) throw new Error(cut.reason);
    expect(cut.losses.lostReports).toEqual([
      { toolUseId: "toolu_a", tool: "Agent", description: "Agent A" },
    ]);
    expect(cut.losses.unreported).toEqual([
      { toolUseId: "toolu_b", tool: "Agent", description: "Agent B" },
    ]);
    // A delivered report is not one of the user's messages.
    expect(cut.losses.laterUserTurns).toBe(0);
  });

  test("a report already delivered before the cut is not a loss; foreground tools never are", () => {
    const cut = cutTranscriptAt(
      lines([
        user("u1", null, "go"),
        launch("l1", "u1", "toolu_a", "Agent A"),
        receipt("r1", "l1", "toolu_a"),
        report("n1", "r1", "toolu_a"),
        launch("l2", "n1", "toolu_fg", "foreground, result never written"),
        assistant("a1", "l2", "done"),
        user("u2", "a1", "next"),
      ]),
      "u2",
    );
    if (!cut.ok) throw new Error(cut.reason);
    expect(cut.losses).toEqual({
      laterUserTurns: 0,
      lostReports: [],
      unreported: [],
    });
  });
});
