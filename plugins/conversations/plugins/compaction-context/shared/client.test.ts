import { afterEach, describe, expect, test } from "bun:test";
import { compactionContext } from "../core/endpoints";
import {
  CompactionContextRefusedError,
  compactionContextPath,
  fetchCompactionContext,
  hookOutput,
} from "./client";

const servers: { stop(): unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

function serve(handler: (req: Request) => Response): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

describe("compactionContextPath", () => {
  test("is the endpoint's route", () => {
    const route = compactionContext.route.replace(/^POST /, "");
    expect(compactionContextPath("conv-1")).toBe(
      route.replace(":id", "conv-1"),
    );
  });
});

describe("fetchCompactionContext", () => {
  test("returns the context the backend answers", async () => {
    let seen = "";
    const baseUrl = serve((req) => {
      seen = `${req.method} ${new URL(req.url).pathname}`;
      return Response.json({ context: "restored" });
    });
    expect(
      await fetchCompactionContext({ baseUrl, conversationId: "conv-1" }),
    ).toBe("restored");
    expect(seen).toBe(`POST ${compactionContextPath("conv-1")}`);
  });

  test("retries a 5xx, then succeeds", async () => {
    let calls = 0;
    const baseUrl = serve(() =>
      ++calls < 3
        ? new Response("starting", { status: 503 })
        : Response.json({ context: "late" }),
    );
    const context = await fetchCompactionContext({
      baseUrl,
      conversationId: "c",
      sleep: () => Promise.resolve(),
    });
    expect(context).toBe("late");
    expect(calls).toBe(3);
  });

  test("a 4xx throws at once", () => {
    let calls = 0;
    const baseUrl = serve(() => {
      calls++;
      return new Response("no", { status: 404 });
    });
    expect(
      fetchCompactionContext({ baseUrl, conversationId: "c" }),
    ).rejects.toBeInstanceOf(CompactionContextRefusedError);
    expect(calls).toBe(1);
  });

  test("gives up once the backend has been unreachable long enough", () => {
    let t = 0;
    expect(
      fetchCompactionContext({
        baseUrl: "http://127.0.0.1:1",
        conversationId: "c",
        sleep: (ms) => {
          t += ms;
          return Promise.resolve();
        },
        now: () => t,
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("hookOutput", () => {
  test("nothing to restore prints nothing", () => {
    expect(hookOutput("")).toBe("");
  });

  test("context rides SessionStart's additionalContext", () => {
    expect(JSON.parse(hookOutput("x"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "x",
      },
    });
  });
});
