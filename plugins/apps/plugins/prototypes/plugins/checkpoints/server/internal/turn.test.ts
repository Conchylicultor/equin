import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  checkpointBody,
  checkpointSubject,
  FALLBACK_SUBJECT,
  findTurnWindow,
  planTurnCheckpoint,
  touchedPrototypeIds,
  turnRequest,
} from "./turn";

const AT = "2026-09-11T00:00:00.000Z";
const A = "proto-1789000001-aaaa";
const B = "proto-1789000002-bbbb";
const C = "proto-1789000003-cccc";
const D = "proto-1789000004-dddd";

const user = (text: string): JsonlEvent => ({
  kind: "user-text",
  at: AT,
  text,
});
const call = (name: string, input: unknown): JsonlEvent => ({
  kind: "tool-call",
  at: AT,
  toolUseId: `tu-${name}-${JSON.stringify(input).length}`,
  name,
  input,
});
const endTurn = (messageId: string, text = "done"): JsonlEvent => ({
  kind: "assistant-text",
  at: AT,
  messageId,
  text,
  stopReason: "end_turn",
});
const midText = (messageId: string): JsonlEvent => ({
  kind: "assistant-text",
  at: AT,
  messageId,
  text: "Let me look.",
  stopReason: "tool_use",
});

const PROTOS = `/data/.singularity/apps/prototypes`;

// Two turns: the first touches C only; the second edits A, runs a Bash command
// on B, and delegates D to a subagent.
const transcript: JsonlEvent[] = [
  user("Make a settings mock"),
  call("Write", { file_path: `${PROTOS}/${C}/index.html`, content: "<html>" }),
  endTurn("msg-1", "Made the settings mock."),
  user("Tighten the header\nand fix the footer spacing"),
  midText("msg-2"),
  call("Edit", {
    file_path: `${PROTOS}/${A}/index.html`,
    old_string: "a",
    new_string: "b",
  }),
  call("Bash", { command: `ls ${PROTOS}\ncp x ${PROTOS}/${B}/styles.css` }),
  call("Agent", {
    description: "polish",
    prompt: `Polish the prototype ${D} — read its index.html first.`,
  }),
  call("Edit", {
    file_path: `${PROTOS}/${A}/index.html`,
    old_string: "b",
    new_string: "c",
  }),
  endTurn("msg-3", "Tightened the header."),
];

describe("findTurnWindow", () => {
  test("starts after the previous end-of-turn and ends at the named message", () => {
    const window = findTurnWindow(transcript, "msg-3");
    expect(window.kind).toBe("found");
    if (window.kind !== "found") return;
    expect(window.events[0]).toEqual(
      user("Tighten the header\nand fix the footer spacing"),
    );
    expect(window.events.at(-1)).toEqual(
      endTurn("msg-3", "Tightened the header."),
    );
    expect(window.messageId).toBe("msg-3");
  });

  test("the first turn starts at the top of the transcript", () => {
    const window = findTurnWindow(transcript, "msg-1");
    if (window.kind !== "found") throw new Error("expected a window");
    expect(window.events).toEqual(transcript.slice(0, 3));
  });

  test("a mid-turn assistant message is not a boundary", () => {
    const window = findTurnWindow(transcript, "msg-3");
    if (window.kind !== "found") throw new Error("expected a window");
    expect(window.events).toContainEqual(midText("msg-2"));
  });

  test("null messageId takes the last end-of-turn, and reports its id", () => {
    const window = findTurnWindow(transcript, null);
    if (window.kind !== "found") throw new Error("expected a window");
    expect(window.messageId).toBe("msg-3");
    expect(window.events).toEqual(findWindowEvents("msg-3"));
  });

  test("a messageId the transcript does not hold finds nothing", () => {
    expect(findTurnWindow(transcript, "msg-rewound")).toEqual({
      kind: "not-found",
    });
  });

  test("an empty transcript finds nothing", () => {
    expect(findTurnWindow([], null)).toEqual({ kind: "not-found" });
    expect(findTurnWindow([], "msg-1")).toEqual({ kind: "not-found" });
  });

  test("an interrupted turn (no end_turn) folds into the next", () => {
    const events: JsonlEvent[] = [
      user("first"),
      endTurn("m1"),
      user("try A"),
      call("Edit", { file_path: `${PROTOS}/${A}/index.html` }),
      user("[Request interrupted by user]"),
      user("try B instead"),
      call("Edit", { file_path: `${PROTOS}/${B}/index.html` }),
      endTurn("m2"),
    ];
    const window = findTurnWindow(events, "m2");
    if (window.kind !== "found") throw new Error("expected a window");
    expect(touchedPrototypeIds(window.events)).toEqual([A, B]);
    expect(turnRequest(window.events)).toBe("try B instead");
  });
});

function findWindowEvents(messageId: string): JsonlEvent[] {
  const window = findTurnWindow(transcript, messageId);
  if (window.kind !== "found") throw new Error("expected a window");
  return window.events;
}

describe("touchedPrototypeIds", () => {
  test("finds ids in Edit paths, Bash commands and Agent prompts, deduped in order", () => {
    expect(touchedPrototypeIds(findWindowEvents("msg-3"))).toEqual([A, B, D]);
  });

  test("ignores ids mentioned only in an earlier turn", () => {
    expect(touchedPrototypeIds(findWindowEvents("msg-3"))).not.toContain(C);
    expect(touchedPrototypeIds(findWindowEvents("msg-1"))).toEqual([C]);
  });

  test("ignores ids outside tool-call inputs", () => {
    expect(
      touchedPrototypeIds([
        user(`look at ${A}`),
        endTurn("m", `I changed ${B}`),
      ]),
    ).toEqual([]);
  });

  test("an id starting a line of a multi-line command is found", () => {
    expect(
      touchedPrototypeIds([call("Bash", { command: `cd x\n${A}` })]),
    ).toEqual([A]);
  });

  test("nested inputs are walked", () => {
    expect(
      touchedPrototypeIds([
        call("MultiEdit", { edits: [{ file_path: `${PROTOS}/${B}/app.jsx` }] }),
      ]),
    ).toEqual([B]);
  });

  test("a longer token is not read as an id", () => {
    expect(
      touchedPrototypeIds([call("Bash", { command: `echo ${A}x x${B}` })]),
    ).toEqual([]);
  });
});

describe("turnRequest", () => {
  test("is the window's last user message", () => {
    expect(turnRequest(findWindowEvents("msg-3"))).toBe(
      "Tighten the header\nand fix the footer spacing",
    );
  });

  test("falls back to a teammate's message, then a task notification", () => {
    const teammate: JsonlEvent = {
      kind: "teammate-message",
      at: AT,
      body: "Build part B",
    };
    const notification: JsonlEvent = {
      kind: "task-notification",
      at: AT,
      taskId: "t1",
      status: "completed",
      summary: "Background build finished",
    };
    expect(turnRequest([notification, teammate, endTurn("m")])).toBe(
      "Build part B",
    );
    expect(turnRequest([notification, endTurn("m")])).toBe(
      "Background build finished",
    );
    expect(turnRequest([endTurn("m")])).toBeNull();
  });
});

describe("checkpointSubject", () => {
  test("is the request's first non-empty line", () => {
    expect(checkpointSubject("\n  \n  Tighten the header  \nand more")).toBe(
      "Tighten the header",
    );
  });

  test("is at most 72 chars, ending in an ellipsis when cut", () => {
    const subject = checkpointSubject("x".repeat(200));
    expect(subject).toHaveLength(72);
    expect(subject.endsWith("…")).toBe(true);
    expect(checkpointSubject("y".repeat(72))).toBe("y".repeat(72));
  });

  test("falls back when there is no request", () => {
    expect(checkpointSubject(null)).toBe(FALLBACK_SUBJECT);
    expect(checkpointSubject("  \n ")).toBe(FALLBACK_SUBJECT);
  });
});

describe("checkpointBody", () => {
  test("holds the request and the agent's summary", () => {
    expect(checkpointBody("do it", "  did it ")).toBe(
      "Request:\ndo it\n\nAgent summary:\ndid it",
    );
  });

  test("truncates each section", () => {
    const body = checkpointBody("r".repeat(5000), "s".repeat(5000));
    const [request, summary] = body.split("\n\n");
    expect(request).toHaveLength("Request:\n".length + 2000);
    expect(summary).toHaveLength("Agent summary:\n".length + 2000);
    expect(summary?.endsWith("…")).toBe(true);
  });

  test("omits a missing section", () => {
    expect(checkpointBody(null, "did it")).toBe("Agent summary:\ndid it");
  });
});

describe("planTurnCheckpoint", () => {
  test("plans one checkpoint per touched prototype with the turn's request", () => {
    expect(
      planTurnCheckpoint(transcript, {
        messageId: "msg-3",
        text: "Tightened the header.",
      }),
    ).toEqual({
      kind: "checkpoint",
      ids: [A, B, D],
      subject: "Tighten the header",
      body: "Request:\nTighten the header\nand fix the footer spacing\n\nAgent summary:\nTightened the header.",
      messageId: "msg-3",
    });
  });

  test("records nothing for a turn that touched no prototype", () => {
    const events = [
      user("hi"),
      call("Read", { file_path: "/tmp/x" }),
      endTurn("m"),
    ];
    expect(
      planTurnCheckpoint(events, { messageId: "m", text: "hello" }),
    ).toEqual({
      kind: "nothing",
      reason: "no-prototype-touched",
    });
  });

  test("records nothing when the turn is not in the transcript", () => {
    expect(
      planTurnCheckpoint(transcript, { messageId: "gone", text: "" }),
    ).toEqual({
      kind: "nothing",
      reason: "turn-not-found",
    });
  });

  test("a null messageId plans the last turn under that turn's id", () => {
    const plan = planTurnCheckpoint(transcript, { messageId: null, text: "x" });
    expect(plan.kind === "checkpoint" && plan.messageId).toBe("msg-3");
  });
});
