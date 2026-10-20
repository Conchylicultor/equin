import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { teammateIdleTimes } from "./teammate-idle";

const teammateMessage = (teammateId: string, body: string): JsonlEvent => ({
  kind: "teammate-message",
  at: "2026-10-07T02:34:05.027Z",
  teammateId,
  body,
});

const idle = (from: string, timestamp: string) =>
  teammateMessage(
    from,
    JSON.stringify({
      type: "idle_notification",
      from,
      timestamp,
      idleReason: "available",
      result: "The web UI is built and deployed.",
    }),
  );

describe("teammateIdleTimes", () => {
  test("the newest idle notification per teammate wins", () => {
    // conv-1790861753-uid9: automations-web reported, was asked to resend the
    // truncated part, resent it, and went idle again.
    const times = teammateIdleTimes([
      idle("automations-web", "2026-10-07T02:33:34.804Z"),
      teammateMessage("automations-web", "Remaining deviations and gaps…"),
      idle("automations-web", "2026-10-07T02:34:00.465Z"),
      idle("automations-server", "2026-10-07T02:10:00.000Z"),
    ]);
    expect(times.get("automations-web")).toBe("2026-10-07T02:34:00.465Z");
    expect(times.get("automations-server")).toBe("2026-10-07T02:10:00.000Z");
  });

  test("prose reports and other status types are not idle notifications", () => {
    expect(
      teammateIdleTimes([
        teammateMessage("a", "{ not json"),
        teammateMessage("a", "Done: everything passed."),
        teammateMessage(
          "a",
          JSON.stringify({ type: "shutdown_approved", from: "a" }),
        ),
      ]).size,
    ).toBe(0);
  });
});
