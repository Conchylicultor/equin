import { afterAll, describe, expect, test } from "bun:test";
import { handOverGateway, readGatewayGeneration } from "./gateway-handover";

// The Go gateway's answers are plain JSON bodies, not endpoint handlers.
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

// A stand-in gateway: answers the handover route the way each kind of real
// gateway does (with a keeper, without one, a failed successor).
let lastBody: unknown = null;
let mode: "keeper" | "no-keeper" | "failed" = "keeper";
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/gateway/handover")
      return new Response("", { status: 404 });
    if (mode === "no-keeper")
      return new Response("404 page not found", { status: 404 });
    if (req.method === "GET") {
      return jsonResponse({
        protocol: 1,
        keeperPid: 10,
        pid: 11,
        mode: "fresh",
        binary: "/bin/gateway",
        args: ["-listen", "loopback:9000"],
        dir: "/",
        startedAt: 1,
      });
    }
    lastBody = await req.json();
    if (mode === "failed") {
      return new Response(
        "handover failed (this gateway keeps serving): exited before ready",
        { status: 502 },
      );
    }
    return jsonResponse({ handedOver: true, pid: 42, tookMs: 17 });
  },
});
const dial = `127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

describe("handOverGateway", () => {
  test("sends only the fields given, the environment as NAME=value", async () => {
    mode = "keeper";
    const out = await handOverGateway({
      dialAddress: dial,
      launch: { binary: "/new/gateway", env: { HOME: "/h", PATH: "/bin" } },
    });
    expect(out).toEqual({ kind: "handed-over", pid: 42, tookMs: 17 });
    expect(lastBody).toEqual({
      binary: "/new/gateway",
      env: ["HOME=/h", "PATH=/bin"],
    });
  });

  test("a gateway with no keeper answers 404: no-keeper, so the caller restarts it", async () => {
    mode = "no-keeper";
    expect(await handOverGateway({ dialAddress: dial, launch: {} })).toEqual({
      kind: "no-keeper",
    });
  });

  test("a successor that did not take over is a failure, with the gateway's reason", async () => {
    mode = "failed";
    const out = await handOverGateway({ dialAddress: dial, launch: {} });
    expect(out.kind).toBe("failed");
    expect(out.kind === "failed" && out.reason).toContain(
      "exited before ready",
    );
  });

  test("nothing listening is a failure, not no-keeper", async () => {
    const out = await handOverGateway({
      dialAddress: "127.0.0.1:1",
      launch: {},
    });
    expect(out.kind).toBe("failed");
  });
});

describe("readGatewayGeneration", () => {
  test("reads the serving generation's launch", async () => {
    mode = "keeper";
    const out = await readGatewayGeneration(dial);
    expect(out.kind === "generation" && out.generation).toEqual({
      pid: 11,
      keeperPid: 10,
      binary: "/bin/gateway",
      args: ["-listen", "loopback:9000"],
    });
  });

  test("no keeper: 404", async () => {
    mode = "no-keeper";
    expect((await readGatewayGeneration(dial)).kind).toBe("no-keeper");
  });
});
