import { describe, expect, test } from "bun:test";
import { reachHostOver } from "./client";

const HEALTHY = {
  ok: true,
  startedAt: 1_794_000_000_000,
  runId: null,
  composition: null,
};

describe("reachHostOver", () => {
  test("no HTTP answer (fetch's network error) is no-answer", async () => {
    const reach = await reachHostOver(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    expect(reach).toEqual({ kind: "no-answer" });
  });

  test("a non-2xx is an answer: the host is reachable", async () => {
    const reach = await reachHostOver(() =>
      Promise.resolve(new Response("bad gateway", { status: 502 })),
    );
    expect(reach).toEqual({ kind: "answered", status: 502, health: null });
  });

  test("a 2xx is an answer with the decoded health", async () => {
    const reach = await reachHostOver(() =>
      Promise.resolve(Response.json(HEALTHY)),
    );
    expect(reach.kind).toBe("answered");
  });

  test("anything but a network error is not swallowed", () => {
    expect(
      reachHostOver(() =>
        Promise.reject(new DOMException("aborted", "AbortError")),
      ),
    ).rejects.toThrow("aborted");
  });
});
