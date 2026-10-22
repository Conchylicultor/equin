import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  asNamespace,
  MAIN_WORKTREE_NAME,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { agentOriginHeaders } from "@plugins/infra/plugins/request-origin/core";
import {
  declareRuntimeNamespace,
  hasRuntimeNamespace,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import { resetRuntimeNamespaceForTest } from "@plugins/infra/plugins/runtime-identity/core/testing";
import { defineEndpoint } from "./define-endpoint";
import { implement, rawEndpointHandler } from "./implement";
import { agentWriteRefusedMessage, isAgentWriteRefusal } from "./agent-write";

// The gate is decided at registration from `isMain()`, so each case declares
// the namespace BEFORE building its handler, and the suite puts the preload's
// declaration back afterwards.
const preloaded: Namespace | undefined = hasRuntimeNamespace()
  ? runtimeNamespace()
  : undefined;

function runAs(ns: Namespace): void {
  resetRuntimeNamespaceForTest();
  declareRuntimeNamespace(ns);
}

afterEach(() => {
  resetRuntimeNamespaceForTest();
  if (preloaded !== undefined) declareRuntimeNamespace(preloaded);
});

const write = defineEndpoint({
  route: "POST /api/thing",
  body: z.object({ a: z.string() }),
  response: z.object({ ran: z.boolean() }),
});
const telemetry = defineEndpoint({
  route: "POST /api/beacon",
  response: z.object({ ran: z.boolean() }),
  agentWrite: "telemetry",
});
const read = defineEndpoint({
  route: "GET /api/thing",
  response: z.object({ ran: z.boolean() }),
});

function request(
  method: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/thing", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify({ a: "x" }),
  });
}

const agent = agentOriginHeaders("e2e:agent-write-test");

describe("main's agent-write gate", () => {
  test("refuses an agent's write on main, before the handler runs", async () => {
    runAs(MAIN_WORKTREE_NAME);
    let ran = false;
    const handler = implement(write, () => {
      ran = true;
      return { ran };
    });
    const res = await handler(request("POST", agent), {});
    expect(res.status).toBe(403);
    const body: unknown = await res.json();
    expect(isAgentWriteRefusal(res.status, body)).toBe(true);
    expect(body).toMatchObject({
      message: agentWriteRefusedMessage(write.route),
    });
    expect(agentWriteRefusedMessage(write.route)).toContain(
      "./singularity build",
    );
    expect(ran).toBe(false);
  });

  test("passes the same write without the agent headers", async () => {
    runAs(MAIN_WORKTREE_NAME);
    const handler = implement(write, () => ({ ran: true }));
    const res = await handler(request("POST"), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ran: true });
  });

  test("passes an agent's write on a namespace other than main", async () => {
    runAs(asNamespace("att-1-test"));
    const handler = implement(write, () => ({ ran: true }));
    const res = await handler(request("POST", agent), {});
    expect(res.status).toBe(200);
  });

  test("passes an agent's write to an endpoint declaring agentWrite", async () => {
    runAs(MAIN_WORKTREE_NAME);
    const handler = implement(telemetry, () => ({ ran: true }));
    const res = await handler(request("POST", agent), {});
    expect(res.status).toBe(200);
  });

  test("never touches a GET", async () => {
    runAs(MAIN_WORKTREE_NAME);
    const handler = implement(read, () => ({ ran: true }));
    const res = await handler(request("GET", agent), {});
    expect(res.status).toBe(200);
  });

  test("a raw write handler is gated the same way", async () => {
    runAs(MAIN_WORKTREE_NAME);
    let ran = false;
    const handler = rawEndpointHandler(write, () => {
      ran = true;
      return new Response("ok");
    });
    expect((await handler(request("POST", agent), {})).status).toBe(403);
    expect(ran).toBe(false);
    expect((await handler(request("POST"), {})).status).toBe(200);
  });

  test("agentWrite on a GET is a boot-time error", () => {
    defineEndpoint({
      route: "GET /api/bogus",
      // @ts-expect-error — a read cannot declare agentWrite (tsc)
      agentWrite: "telemetry",
    });
    // …and a contract assembled around the type still fails at registration.
    const bogus = {
      ...defineEndpoint({ route: "GET /api/bogus" }),
      agentWrite: "telemetry" as const,
    };
    expect(() => implement(bogus, () => undefined)).toThrow(/agentWrite/);
  });
});
