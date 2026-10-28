import { afterEach, describe, expect, test } from "bun:test";
import { stopGate } from "../core/endpoints";
import {
  fetchStopGate,
  hookOutput,
  StopGateRefusedError,
  stopGatePath,
  stopHookActive,
} from "./client";

const servers: { stop(): unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

/** Await `p` and return what it rejected with; throw if it resolved. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

function serve(handler: (req: Request) => Response): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

describe("stopGatePath", () => {
  test("is the endpoint's route", () => {
    const route = stopGate.route.replace(/^GET /, "");
    expect(stopGatePath("conv-1")).toBe(route.replace(":id", "conv-1"));
  });
});

describe("fetchStopGate", () => {
  test("returns the backend's decision", async () => {
    let seen = "";
    const baseUrl = serve((req) => {
      seen = `${req.method} ${new URL(req.url).pathname}`;
      return Response.json({ decision: "block", reason: "report first" });
    });
    expect(await fetchStopGate({ baseUrl, conversationId: "conv-1" })).toEqual({
      decision: "block",
      reason: "report first",
    });
    expect(seen).toBe(`GET ${stopGatePath("conv-1")}`);
  });

  test("retries a 5xx, then succeeds", async () => {
    let calls = 0;
    const baseUrl = serve(() =>
      ++calls < 3
        ? new Response("starting", { status: 503 })
        : Response.json({ decision: "allow", reason: null }),
    );
    expect(
      await fetchStopGate({
        baseUrl,
        conversationId: "c",
        sleep: () => Promise.resolve(),
      }),
    ).toEqual({ decision: "allow", reason: null });
    expect(calls).toBe(3);
  });

  test("a 4xx throws at once", async () => {
    let calls = 0;
    const baseUrl = serve(() => {
      calls++;
      return new Response("no", { status: 404 });
    });
    expect(
      await rejection(fetchStopGate({ baseUrl, conversationId: "c" })),
    ).toBeInstanceOf(StopGateRefusedError);
    expect(calls).toBe(1);
  });

  test("a malformed answer throws at once", async () => {
    const baseUrl = serve(() => Response.json({ decision: "maybe" }));
    expect(
      await rejection(fetchStopGate({ baseUrl, conversationId: "c" })),
    ).toBeInstanceOf(StopGateRefusedError);
  });

  test("gives up once the backend has been unreachable long enough", async () => {
    let t = 0;
    expect(
      await rejection(
        fetchStopGate({
          baseUrl: "http://127.0.0.1:1",
          conversationId: "c",
          sleep: (ms) => {
            t += ms;
            return Promise.resolve();
          },
          now: () => t,
        }),
      ),
    ).toBeInstanceOf(Error);
  });
});

describe("stopHookActive", () => {
  test("reads the CLI's flag", () => {
    expect(stopHookActive(JSON.stringify({ stop_hook_active: true }))).toBe(
      true,
    );
    expect(stopHookActive(JSON.stringify({ stop_hook_active: false }))).toBe(
      false,
    );
    expect(stopHookActive(JSON.stringify({ session_id: "s" }))).toBe(false);
  });

  test("stdin that is not the hook's JSON object throws", () => {
    expect(() => stopHookActive("")).toThrow();
    expect(() => stopHookActive("[]")).toThrow(/not a JSON object/);
  });
});

describe("hookOutput", () => {
  test("allow prints nothing", () => {
    expect(hookOutput({ decision: "allow", reason: null })).toBe("");
    expect(hookOutput({ decision: "allow", reason: "waived" })).toBe("");
  });

  test("block sends the agent back with the reason", () => {
    expect(
      JSON.parse(hookOutput({ decision: "block", reason: "report first" })),
    ).toEqual({ decision: "block", reason: "report first" });
  });
});
