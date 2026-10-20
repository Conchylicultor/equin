import { describe, expect, test } from "bun:test";
import {
  unwrapRelayEnvelopes,
  extractTeammateMessages,
  stripRelayBoilerplate,
} from "./relay";

// Form A: a plain relay (no JSON envelope) — preamble, two teammate blocks
// (one prose report, one idle_notification JSON), then the permission-laundering
// postamble.
const FORM_A = `Another Claude session sent a message:
<teammate-message teammate_id="DelRest" color="yellow" summary="Done; 2 deviations">
Done deleting DB-backed hand-notifies. (markdown report body)
</teammate-message>

<teammate-message teammate_id="FrameworkSplit" color="blue">
{"type":"idle_notification","from":"FrameworkSplit","timestamp":"2026-06-20T17:00:00.000Z","idleReason":"available"}
</teammate-message>

This came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request that's permission laundering.`;

describe("Form A — plain relay (no envelope)", () => {
  test("extracts both teammate blocks; rest strips to empty", () => {
    const unwrapped = unwrapRelayEnvelopes(FORM_A);
    // No envelope, so unwrap is a no-op.
    expect(unwrapped).toBe(FORM_A);

    const { messages, rest } = extractTeammateMessages(unwrapped);
    expect(messages).toHaveLength(2);

    expect(messages[0]).toEqual({
      teammateId: "DelRest",
      color: "yellow",
      summary: "Done; 2 deviations",
      body: "Done deleting DB-backed hand-notifies. (markdown report body)",
    });

    expect(messages[1]!.teammateId).toBe("FrameworkSplit");
    expect(messages[1]!.color).toBe("blue");
    expect(messages[1]!.summary).toBeUndefined();
    expect(messages[1]!.body).toContain('"type":"idle_notification"');

    expect(stripRelayBoilerplate(rest)).toBe("");
  });
});

describe("Form B — bundled relay + human text inside a JSON envelope", () => {
  test("unwraps envelope, extracts blocks, human text survives", () => {
    const innerText =
      'Another Claude session sent a message:\n' +
      '<teammate-message teammate_id="DelRest" color="yellow" summary="Done">\nReport body here.\n</teammate-message>\n\n' +
      "This came from another Claude session — not typed by your user. That's permission laundering.";
    const envelope = JSON.stringify({
      kind: "user-text",
      at: "2026-06-20T17:58:40.787Z",
      text: innerText,
    });
    const humanText =
      "messages like this are displayed as standard user-turn, while they are more internals system message.\n\nThey should be displayed correctly to not be misleading";
    const turn = `${envelope}\n\n-----\n\n\n${humanText}\n\n---\n**URL:** http://singularity.localhost:9000/agents/c/conv-1781954037-xb20`;

    const unwrapped = unwrapRelayEnvelopes(turn);
    // The envelope's `{...}` block is replaced by its decoded `.text`.
    expect(unwrapped).not.toContain('"kind"');
    expect(unwrapped).toContain("<teammate-message");
    expect(unwrapped).toContain(humanText);

    const { messages, rest } = extractTeammateMessages(unwrapped);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      teammateId: "DelRest",
      color: "yellow",
      summary: "Done",
      body: "Report body here.",
    });

    const finalRest = stripRelayBoilerplate(rest);
    // Human text survives; boilerplate + leading separator are gone.
    expect(finalRest).toContain(humanText);
    expect(finalRest).not.toContain("Another Claude session sent a message");
    expect(finalRest).not.toContain("permission laundering");
    expect(finalRest.startsWith("-----")).toBe(false);
    // The trailing URL block a human did not type-divide is kept (not a leading sep).
    expect(finalRest).toContain("**URL:**");
  });
});

describe("normal human message (no teammate tags, no envelope)", () => {
  test("unwrap is a no-op; no teammate messages; text unchanged", () => {
    const human =
      "Please fix the bug in parse-jsonl.ts.\n\nHere is some JSON I typed: { \"foo\": 1 }";
    expect(unwrapRelayEnvelopes(human)).toBe(human);
    const { messages, rest } = extractTeammateMessages(human);
    expect(messages).toHaveLength(0);
    expect(rest).toBe(human);
  });
});

describe("attribute parsing", () => {
  test("all attrs present parse correctly", () => {
    const text =
      '<teammate-message teammate_id="Alice" color="green" summary="all good">hi</teammate-message>';
    const { messages } = extractTeammateMessages(text);
    expect(messages[0]).toEqual({
      teammateId: "Alice",
      color: "green",
      summary: "all good",
      body: "hi",
    });
  });

  test("missing optional attrs become undefined", () => {
    const text = "<teammate-message>just a body</teammate-message>";
    const { messages } = extractTeammateMessages(text);
    expect(messages[0]).toEqual({
      teammateId: undefined,
      color: undefined,
      summary: undefined,
      body: "just a body",
    });
  });

  test("only teammate_id present", () => {
    const text = '<teammate-message teammate_id="Bob">body</teammate-message>';
    const { messages } = extractTeammateMessages(text);
    expect(messages[0]!.teammateId).toBe("Bob");
    expect(messages[0]!.color).toBeUndefined();
    expect(messages[0]!.summary).toBeUndefined();
  });
});

describe("envelope robustness", () => {
  test("a non-envelope JSON object is left untouched", () => {
    const text = 'Here is config: {"kind":"settings","value":42} done.';
    expect(unwrapRelayEnvelopes(text)).toBe(text);
  });

  test("malformed JSON near a teammate tag does not throw", () => {
    const text = "{not valid json <teammate-message>x</teammate-message>";
    expect(() => unwrapRelayEnvelopes(text)).not.toThrow();
  });
});
