import { describe, expect, test } from "bun:test";
import { readSendMessage } from "./send-message";

const ok = (body: object) => ({ content: JSON.stringify(body) });

describe("readSendMessage", () => {
  test("a queued message to a running sub-agent named by id", () => {
    const call = readSendMessage(
      {
        to: "ada675279bc6c2b2a",
        summary: "Flow feels jerky before/after",
        message: "More user feedback\nsecond line",
      },
      ok({
        success: true,
        message:
          "Message queued for delivery to ada675279bc6c2b2a at its next tool round.",
        pin: { id: "ada675279bc6c2b2a", name: "ada675279bc6c2b2a" },
      }),
    );
    expect(call.recipient).toEqual({
      kind: "agent-id",
      agentId: "ada675279bc6c2b2a",
      short: "ada6752",
    });
    expect(call.headline).toBe("Flow feels jerky before/after");
    expect(call.delivery).toEqual({ kind: "queued" });
    expect(call.agentId).toBe("ada675279bc6c2b2a");
  });

  test("a send that resumed a stopped, named sub-agent", () => {
    const call = readSendMessage(
      { to: "engine", message: "Resume the work" },
      ok({
        success: true,
        message: "Resuming agent engine",
        resumedAgentId: "aa954de9ab9950e6c",
        pin: { id: "aa954de9ab9950e6c", name: "engine" },
      }),
    );
    expect(call.recipient).toEqual({ kind: "name", name: "engine" });
    expect(call.headline).toBe("Resume the work");
    expect(call.delivery).toEqual({
      kind: "resumed",
      agentId: "aa954de9ab9950e6c",
    });
    expect(call.agentId).toBe("aa954de9ab9950e6c");
  });

  test("a protocol reply and a name with its ref", () => {
    const call = readSendMessage(
      {
        to: "team-lead [3fa9c1]",
        message: { type: "shutdown_response", request_id: "r1", approve: true },
      },
      undefined,
    );
    expect(call.recipient).toEqual({ kind: "name", name: "team-lead" });
    expect(call.body).toEqual({
      kind: "protocol",
      headline: "Shutdown response · approved",
      detail: undefined,
    });
    expect(call.delivery).toEqual({ kind: "pending" });
    expect(call.agentId).toBeUndefined();
  });

  test("an idle subscription with no message, and a failed send", () => {
    const call = readSendMessage(
      { to: "worker", notify_when_idle: true },
      { content: "No agent named worker", isError: true },
    );
    expect(call.body).toEqual({ kind: "none" });
    expect(call.headline).toBe("Notify when idle");
    expect(call.notifyWhenIdle).toBe(true);
    expect(call.delivery).toEqual({
      kind: "failed",
      reason: "No agent named worker",
    });
  });

  test("main, and a prose receipt", () => {
    const call = readSendMessage(
      { to: "main", message: "done" },
      { content: "Delivered to the main conversation." },
    );
    expect(call.recipient).toEqual({ kind: "main" });
    expect(call.delivery).toEqual({
      kind: "sent",
      text: "Delivered to the main conversation.",
    });
  });
});
