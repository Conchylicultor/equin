/**
 * `readCost: "memory"` — a read that answers from memory this process holds
 * takes no read-admission slot, so it never queues behind reads doing I/O
 * (main, 2026-11-06: `icons.sprite` waited 2.4 s behind git loaders). A repeat
 * read of a tuple slower than the budget breaks the declaration and is
 * reported, once per key.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { controllable, createHarness, tick } from "./test-support";

let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  error.mockRestore();
});

function get(h: ReturnType<typeof createHarness>, key: string) {
  return h.runtime.handleResourceHttp(
    new Request(`http://x/api/resources/${key}`),
    { key },
  );
}

describe("readCost: memory", () => {
  test("answers while every read-admission slot is held by I/O reads", async () => {
    const h = createHarness();
    const ctl = controllable("v");
    // Eight keys, so no key's share (READ_KEY_SHARE) is what caps them.
    for (let k = 0; k < 8; k++) {
      h.runtime.defineExternalResource({
        key: `io${k}`,
        mode: "push",
        schema: z.string(),
        loader: () => ctl.loader(),
      });
    }
    h.runtime.defineExternalResource({
      key: "mem",
      mode: "push",
      schema: z.string(),
      readCost: "memory",
      revalidate: () => Promise.resolve("sig"),
      loader: () => Promise.resolve("held"),
    });

    ctl.block();
    for (let k = 0; k < 8; k++) await h.subscribe(`io${k}`);
    expect(h.runtime.readGateStats()).toMatchObject({ active: 6, queued: 2 });

    await h.subscribe("mem");
    await tick();
    const ack = h.frames.find((f) => f.kind === "sub-ack" && f.key === "mem");
    expect(ack?.value).toBe("held");
    // It neither took a slot nor joined the queue.
    expect(h.runtime.readGateStats()).toMatchObject({ active: 6, queued: 2 });

    ctl.release();
    await tick();
  });

  test("a slow read of a warm tuple is reported once; reads before it is warm are exempt", async () => {
    const reports: string[] = [];
    const h = createHarness({
      reportError: (context) => reports.push(context),
    });
    const delayMs = 300;
    h.runtime.defineExternalResource({
      key: "mem",
      mode: "invalidate",
      schema: z.string(),
      readCost: "memory",
      loader: async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        return "v";
      },
    });

    // First read of the tuple: a memo's cold build may be slow.
    expect((await get(h, "mem")).status).toBe(200);
    expect(reports).toEqual([]);
    // A repeat read that is just as slow did I/O without a slot.
    expect((await get(h, "mem")).status).toBe(200);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('"mem" is declared readCost "memory"');
    // Once per key.
    expect((await get(h, "mem")).status).toBe(200);
    expect(reports).toHaveLength(1);
  });

  test("reads that all start cold (concurrent, waiting on one warm-up) are exempt", async () => {
    const reports: string[] = [];
    const h = createHarness({
      reportError: (context) => reports.push(context),
    });
    const ctl = controllable("v");
    h.runtime.defineExternalResource({
      key: "mem",
      mode: "invalidate",
      schema: z.string(),
      readCost: "memory",
      // Every probe waits on the same warm-up (a registry coming up).
      revalidate: async () => {
        await ctl.loader();
        return "sig";
      },
      loader: () => Promise.resolve("v"),
    });

    ctl.block();
    const reads = [get(h, "mem"), get(h, "mem")];
    await new Promise((r) => setTimeout(r, 300));
    ctl.release();
    for (const res of await Promise.all(reads)) expect(res.status).toBe(200);
    expect(reports).toEqual([]);
  });
});
