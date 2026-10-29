/**
 * `mcp.health` is what real requests saw: the latest request's outcome, and
 * every contribution whose latest run threw (cleared by its next clean run).
 *
 * Run: `./equin test plugins/infra/plugins/mcp`
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setErrorReporter } from "@plugins/framework/plugins/server-core/core";
import { handleMcpRequest } from "./handle-mcp";
import { currentMcpHealth, resetMcpHealth } from "./health";
import { Mcp } from "./mcp";
import { registry, scopeRegistry } from "./registry";

function listTools(): Promise<Response> {
  return handleMcpRequest(
    new Request("http://localhost/api/mcp/conv-test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    { conversationId: "conv-test" },
  );
}

let gateOpen: () => boolean;

beforeEach(() => {
  resetMcpHealth();
  setErrorReporter(() => {});
  gateOpen = () => true;
  void Mcp.tool({
    name: "gated",
    description: "gated",
    inputSchema: {},
    when: () => gateOpen(),
    handler: () => ({ content: [{ type: "text", text: "ok" }] }),
  }).register();
});

afterEach(() => {
  registry.clear();
  scopeRegistry.resolver = null;
});

describe("mcp.health", () => {
  test("nothing has asked yet: none", () => {
    expect(currentMcpHealth()).toEqual({
      requests: { kind: "none" },
      degraded: [],
      degradedMore: 0,
    });
  });

  test("an answered request is ok", async () => {
    expect((await listTools()).status).toBe(200);
    expect(currentMcpHealth().requests).toEqual({ kind: "ok" });
  });

  test("a request that throws is failing, rethrown; the next good one is ok", async () => {
    scopeRegistry.resolver = () => Promise.reject(new Error("scope broke"));
    const thrown = await listTools().then(
      () => null,
      (err: unknown) => err,
    );
    expect(thrown instanceof Error && thrown.message).toBe("scope broke");
    const failing = currentMcpHealth().requests;
    expect(failing.kind).toBe("failing");
    expect(failing.kind === "failing" && failing.message).toBe("scope broke");

    scopeRegistry.resolver = null;
    await listTools();
    expect(currentMcpHealth().requests).toEqual({ kind: "ok" });
  });

  test("a throwing contribution is degraded until it runs cleanly", async () => {
    gateOpen = () => {
      throw new Error("gate broke");
    };
    await listTools();
    const health = currentMcpHealth();
    expect(health.requests).toEqual({ kind: "ok" });
    expect(health.degraded.map((d) => [d.what, d.message])).toEqual([
      ['tool "gated" when', "gate broke"],
    ]);

    gateOpen = () => true;
    await listTools();
    expect(currentMcpHealth().degraded).toEqual([]);
  });
});
