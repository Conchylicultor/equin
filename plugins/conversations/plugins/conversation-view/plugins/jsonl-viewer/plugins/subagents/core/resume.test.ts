import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { agentResumeTimes } from "./resume";

const sendMessage = (at: string, content: string | undefined): JsonlEvent => ({
  kind: "tool-call",
  at,
  toolUseId: `toolu_${at}`,
  name: "SendMessage",
  input: { to: "a1e0d7d9ad5e40dcd", message: "…" },
  ...(content === undefined ? {} : { result: { at, content } }),
});

const resumed = (agentId: string) =>
  JSON.stringify({
    success: true,
    message: `Resuming agent ${agentId.slice(0, 7)}`,
    resumedAgentId: agentId,
    pin: { id: agentId, name: agentId, ref: "232f74" },
  });

describe("agentResumeTimes", () => {
  test("the newest resume per agent wins", () => {
    // conv-1791379404-0sgk: one background agent resumed four times.
    const times = agentResumeTimes([
      sendMessage("2026-10-07T13:44:05.066Z", resumed("a1e0d7d9ad5e40dcd")),
      sendMessage("2026-10-07T13:57:10.551Z", resumed("a1e0d7d9ad5e40dcd")),
      sendMessage("2026-10-07T13:50:00.000Z", resumed("other")),
    ]);
    expect(times.get("a1e0d7d9ad5e40dcd")).toBe("2026-10-07T13:57:10.551Z");
    expect(times.get("other")).toBe("2026-10-07T13:50:00.000Z");
  });

  test("a message queued to a running agent, a failed send, or no result yet is not a resume", () => {
    expect(
      agentResumeTimes([
        sendMessage(
          "2026-10-07T13:45:34.669Z",
          JSON.stringify({ success: true, message: "Message queued" }),
        ),
        sendMessage("2026-10-07T13:46:00.000Z", "Error: no such agent"),
        sendMessage("2026-10-07T13:47:00.000Z", undefined),
      ]).size,
    ).toBe(0);
  });
});
