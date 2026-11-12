import { afterEach, describe, expect, test } from "bun:test";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { BackendHoldError, holdBackendDown, startBackend } from "./hold";

const realFetch = globalThis.fetch;
const calls: string[] = [];

function gatewayAnswers(answer: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return answer();
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

const ns = asNamespace("sonata.att-1-x");

describe("holdBackendDown", () => {
  test("asks the gateway for a held stop of exactly this namespace", async () => {
    gatewayAnswers(() => Response.json({ held: true }));
    const held = await holdBackendDown(ns);
    expect(held.namespace).toBe(ns);
    expect(calls).toEqual([
      "http://localhost:9000/gateway/worktrees/sonata.att-1-x/stop?hold=1",
    ]);
  });

  test("a stop the gateway did not hold is refused", () => {
    gatewayAnswers(() => Response.json({ held: false }));
    expect(holdBackendDown(ns)).rejects.toThrow(BackendHoldError);
  });

  test("a gateway that predates the hold (no field) is refused", () => {
    gatewayAnswers(() => Response.json({ name: ns }));
    expect(holdBackendDown(ns)).rejects.toThrow(/did not hold it down/);
  });

  test("a failed stop is refused", () => {
    gatewayAnswers(() => new Response("worktree is stopping", { status: 503 }));
    expect(holdBackendDown(ns)).rejects.toThrow(/gateway 503/);
  });

  test("an unregistered namespace has nothing to hold", async () => {
    gatewayAnswers(() => new Response("not found", { status: 404 }));
    expect((await holdBackendDown(ns)).namespace).toBe(ns);
  });

  test("an unreachable gateway runs no backend", async () => {
    gatewayAnswers(() => {
      throw new TypeError("fetch failed");
    });
    expect((await holdBackendDown(ns)).namespace).toBe(ns);
  });
});

describe("startBackend", () => {
  test("deploy-starts the held namespace", async () => {
    gatewayAnswers(() => Response.json({ held: true }));
    const held = await holdBackendDown(ns);
    gatewayAnswers(() => Response.json({ state: "running" }));
    await startBackend(held);
    expect(calls.at(-1)).toBe(
      "http://localhost:9000/gateway/worktrees/sonata.att-1-x/restart",
    );
  });

  test("a boot failure is thrown", async () => {
    gatewayAnswers(() => new Response("{}", { status: 404 }));
    const held = await holdBackendDown(ns);
    gatewayAnswers(() => new Response("boot crashed", { status: 502 }));
    expect(startBackend(held)).rejects.toThrow(/failed to boot/);
  });
});
