// A batch the server refuses (4xx) is dropped and the failure thrown — it would
// be refused again on every retry, taking every later sample of the tab with
// it. A server that is down (5xx) keeps the batch for the next flush.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EndpointError } from "@plugins/infra/plugins/endpoints/web";
import { flush, recordInteraction } from "../internal/client-ledger";
import type { Interaction } from "../../core";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@plugins/infra/plugins/endpoints/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchEndpointOver: () => send,
}));

const interaction = (route: string): Interaction => ({
  kind: "navigate",
  occurredAt: 1,
  route,
  durationMs: 10,
  hidden: false,
  censored: false,
  resourceCount: 0,
  lastResourceKey: null,
});

function sentRoutes(call: number): string[] {
  const body = (
    send.mock.calls[call]![2] as { body: { interactions: Interaction[] } }
  ).body;
  return body.interactions.map((i) => i.route);
}

afterEach(() => {
  send.mockReset();
});

describe("client ledger flush", () => {
  it("keeps a batch the server could not take (5xx) for the next flush", async () => {
    send.mockRejectedValueOnce(new EndpointError(503, null));
    recordInteraction(interaction("/a"));
    await flush();
    send.mockResolvedValueOnce({ ok: true });
    await flush();
    expect(sentRoutes(1)).toEqual(["/a"]);
  });

  it("drops a batch the server refused (4xx) and throws", async () => {
    send.mockRejectedValueOnce(new EndpointError(400, { message: "bad" }));
    recordInteraction(interaction("/bad"));
    await expect(flush()).rejects.toThrow("HTTP 400");
    send.mockResolvedValueOnce({ ok: true });
    recordInteraction(interaction("/next"));
    await flush();
    expect(sentRoutes(1)).toEqual(["/next"]);
  });
});
