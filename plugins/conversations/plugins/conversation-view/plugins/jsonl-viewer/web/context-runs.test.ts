import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { ContextRole } from "./slots";
import { groupContextRuns } from "./context-runs";

const at = "2026-10-14T00:00:00.000Z";
const att = (subtype: string): JsonlEvent => ({
  kind: "attachment",
  at,
  subtype,
  attachment: { type: subtype },
});
const user = (text: string): JsonlEvent => ({ kind: "user-text", at, text });
const assistant: JsonlEvent = { kind: "assistant-text", at, text: "ok" };
const info: JsonlEvent = {
  kind: "system",
  at,
  subtype: "informational",
  text: "Compacted while idle",
};
const compaction: JsonlEvent = { kind: "compaction", at, files: [] };

const CONTEXT = new Set([
  "instructions",
  "environment",
  "model",
  "skill_listing",
]);
const CONVERSATION = new Set(["file", "hook_non_blocking_error"]);

function roleOf(e: JsonlEvent): ContextRole | undefined {
  if (e.kind === "system" && e.subtype === "informational") return "ambient";
  if (e.kind !== "attachment") return undefined;
  if (CONTEXT.has(e.subtype)) return "context";
  if (CONVERSATION.has(e.subtype)) return "conversation";
  return "ambient"; // unrendered subtype
}
const isHost = (e: JsonlEvent) => e.kind === "compaction";
const group = (events: JsonlEvent[]) =>
  groupContextRuns(events, roleOf, isHost);

describe("groupContextRuns", () => {
  test("the start context split by the first prompt is two session folds", () => {
    expect(
      group([
        att("instructions"),
        att("credential_org"),
        user("hi"),
        att("environment"),
        att("model"),
        assistant,
      ]),
    ).toEqual([
      { kind: "fold", phase: "session", members: [0, 1] },
      { kind: "event", index: 2 },
      { kind: "fold", phase: "session", members: [3, 4] },
      { kind: "event", index: 5 },
    ]);
  });

  test("a run after the agent first answers is a context update", () => {
    expect(group([assistant, att("environment"), att("model")])).toEqual([
      { kind: "event", index: 0 },
      { kind: "fold", phase: "update", members: [1, 2] },
    ]);
  });

  test("a single context row still folds", () => {
    expect(group([att("model"), user("hi"), assistant, att("model")])).toEqual([
      { kind: "fold", phase: "session", members: [0] },
      { kind: "event", index: 1 },
      { kind: "event", index: 2 },
      { kind: "fold", phase: "update", members: [3] },
    ]);
  });

  test("an ambient-only run stays rows", () => {
    expect(group([assistant, info, att("credential_org")])).toEqual([
      { kind: "event", index: 0 },
      { kind: "event", index: 1 },
      { kind: "event", index: 2 },
    ]);
  });

  test("conversation attachments break a run", () => {
    expect(
      group([
        att("environment"),
        att("model"),
        att("file"),
        att("skill_listing"),
        att("hook_non_blocking_error"),
      ]),
    ).toEqual([
      { kind: "fold", phase: "session", members: [0, 1] },
      { kind: "event", index: 2 },
      { kind: "fold", phase: "session", members: [3] },
      { kind: "event", index: 4 },
    ]);
  });

  test("the run after a compaction folds into it, ambient members included", () => {
    expect(
      group([
        assistant,
        compaction,
        att("invoked_skills"),
        att("environment"),
        info,
        user("next"),
      ]),
    ).toEqual([
      { kind: "event", index: 0 },
      { kind: "event", index: 1, hosted: [2, 3, 4] },
      { kind: "event", index: 5 },
    ]);
  });

  test("a host takes even a single-member run", () => {
    expect(group([compaction, info])).toEqual([
      { kind: "event", index: 0, hosted: [1] },
    ]);
  });
});
