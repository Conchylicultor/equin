import { describe, expect, test } from "bun:test";
import { createTurnEndTracker, type TurnEnd } from "../../core";
import { buildJsonlEvents } from "./parse-jsonl";

// The turn-end tracker (core/turn-end.ts) follows a transcript a line at a
// time; buildJsonlEvents builds the whole chain. They must agree on which turns
// ended: a finished turn is what the turn-emitter announces.

const noImages = () => Promise.resolve(null);

let n = 0;
let parent: string | null = null;
function line(fields: Record<string, unknown>): Record<string, unknown> {
  const uuid = `l${++n}`;
  const out = {
    uuid,
    parentUuid: parent,
    timestamp: new Date(Date.UTC(2026, 10, 12, 0, 0, n)).toISOString(),
    ...fields,
  };
  parent = uuid;
  return out;
}
const prompt = (text: string) =>
  line({ type: "user", message: { role: "user", content: text } });
const assistant = (
  id: string,
  stop: string,
  blocks: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) =>
  line({
    type: "assistant",
    ...extra,
    message: { role: "assistant", id, stop_reason: stop, content: blocks },
  });
const text = (t: string) => ({ type: "text", text: t });
const stopBlock = () =>
  line({
    type: "attachment",
    attachment: {
      type: "hook_blocking_error",
      hookEvent: "Stop",
      hookName: "Stop",
      blockingError: "not yet",
    },
  });
const summary = () => line({ type: "system", subtype: "stop_hook_summary" });

async function fromBuilder(
  lines: Record<string, unknown>[],
): Promise<TurnEnd[]> {
  const events = await buildJsonlEvents(lines, noImages);
  return events.flatMap((e) =>
    e.kind === "assistant-text" &&
    e.stopReason === "end_turn" &&
    e.stopHooks === "allowed" &&
    typeof e.messageId === "string"
      ? [{ messageId: e.messageId, text: e.text }]
      : [],
  );
}

function fromTracker(lines: Record<string, unknown>[]): TurnEnd[] {
  const tracker = createTurnEndTracker();
  return lines.flatMap((l) => {
    const ended = tracker.feed(l);
    return ended ? [ended] : [];
  });
}

function transcript(): Record<string, unknown>[] {
  n = 0;
  parent = null;
  return [
    prompt("hello"),
    // An allowed stop, its text over two lines of one message.
    assistant("m1", "end_turn", [{ type: "thinking", thinking: "…" }]),
    assistant("m1", "end_turn", [text("Done.")]),
    summary(),
    prompt("again"),
    // Tool use, then a stop a hook blocks, then the agent goes on and stops.
    assistant("m2", "tool_use", [
      text("Looking"),
      { type: "tool_use", id: "t1", name: "Bash", input: {} },
    ]),
    line({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    }),
    assistant("m3", "end_turn", [text("Finished?")]),
    stopBlock(),
    summary(),
    assistant("m4", "end_turn", [text("Now finished.")]),
    summary(),
    // An API error is no turn of the agent's.
    prompt("third"),
    assistant("m5", "end_turn", [text("API Error")], {
      isApiErrorMessage: true,
    }),
    summary(),
    // A summary with no end_turn before it ends nothing.
    summary(),
    prompt("fourth"),
    // The last message's Stop hooks have not answered yet.
    assistant("m6", "end_turn", [text("Pending")]),
  ];
}

describe("createTurnEndTracker", () => {
  test("agrees with buildJsonlEvents on which turns ended", async () => {
    const lines = transcript();
    const built = await fromBuilder(lines);
    expect(built.map((t) => t.messageId)).toEqual(["m1", "m4"]);
    expect(fromTracker(lines)).toEqual(built);
  });

  test("a turn pending at the end ends with the summary appended later", async () => {
    const lines = transcript();
    const tracker = createTurnEndTracker();
    for (const l of lines) tracker.feed(l);
    const later = summary();
    expect(tracker.feed(later)).toEqual({ messageId: "m6", text: "Pending" });
    expect((await fromBuilder([...lines, later])).at(-1)).toEqual({
      messageId: "m6",
      text: "Pending",
    });
  });
});
