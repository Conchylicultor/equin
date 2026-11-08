/**
 * What a replayed sub costs on the read path — the post-boot herd's per-entry
 * price (research/2026-10-30-global-cross-boot-resubscribe-resume-epoch.md):
 *
 * - a guarded external with no routing record captures NO commit watermark
 *   while the drift guard is armed (it reads no Postgres; the xmin round trip
 *   inside a read-admission slot bought nothing);
 * - nor does any external whose last loader run read no table (a routed one
 *   included: a reach plan routes changes, it does not make the loader read);
 * - concurrent flights share ONE watermark capture;
 * - a `revalidate` resource declared `notified` keeps the same-boot version
 *   short-circuit (its notify stream is its complete change signal) — its ETag
 *   answers only what the counter cannot.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { mintReachPlan } from "./routing";
import { createHarness, tick } from "./test-support";

function countingCapture(): { fn: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    fn: async () => `${100 + calls++}`,
    calls: () => calls,
  };
}

describe("watermark capture — only for a flight that may read Postgres", () => {
  test("a guarded external with no routing captures none while the drift guard is armed", async () => {
    const cap = countingCapture();
    const h = createHarness({
      captureWatermark: cap.fn,
      lastReadSet: () => [],
    });
    h.runtime.defineExternalResource({
      key: "cfg",
      mode: "push",
      schema: z.string(),
      loader: async () => "doc",
      freshness: { kind: "notified" },
    });

    await h.subscribe("cfg");
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(ack.value).toBe("doc");
    expect("watermark" in ack).toBe(false);
    expect(cap.calls()).toBe(0);
  });

  test("an external the guard does not cover (snapshot freshness), with no run captured yet, captures", async () => {
    const cap = countingCapture();
    const h = createHarness({
      captureWatermark: cap.fn,
      lastReadSet: () => undefined,
    });
    h.runtime.defineExternalResource({
      key: "snap",
      mode: "push",
      schema: z.string(),
      loader: async () => "v",
      freshness: { kind: "snapshot", reason: "measured on read" },
    });

    await h.subscribe("snap");
    expect(h.frames.find((f) => f.kind === "sub-ack")!.watermark).toBe("100");
    expect(cap.calls()).toBe(1);
  });

  test("with no read capture wired nothing proves the external DB-free — it captures", async () => {
    const cap = countingCapture();
    const h = createHarness({ captureWatermark: cap.fn });
    h.runtime.defineExternalResource({
      key: "cfg",
      mode: "push",
      schema: z.string(),
      loader: async () => "doc",
      freshness: { kind: "notified" },
    });

    await h.subscribe("cfg");
    expect(h.frames.find((f) => f.kind === "sub-ack")!.watermark).toBe("100");
  });
});

// A routed external — a reach plan routes a write to it — whose loader may or
// may not read Postgres: `conversations.partial-message`'s shape (a lookup
// read once by its watcher, every push answered from memory).
function routedExternal(loaderReads: string[]) {
  const cap = countingCapture();
  const h = createHarness({
    captureWatermark: cap.fn,
    // The per-run capture: what the loader read, once it has run.
    lastReadSet: (key) =>
      key === "msg" && loads > 0 ? loaderReads : undefined,
  });
  let loads = 0;
  const r = h.runtime.defineExternalResource(
    {
      key: "msg",
      schema: z.number(),
      validateParams: () => {},
    },
    {
      mode: "push",
      freshness: { kind: "notified" },
      reach: mintReachPlan({
        routes: [
          {
            id: "c",
            table: "conversations",
            map: { kind: "full", reason: "the runtime row" },
            columns: ["id"],
          },
        ],
        usesOf: () => new Map([["c", { role: "membership" as const }]]),
      }),
      loader: async () => ++loads,
    },
  );
  return { h, r, cap };
}

describe("watermark capture — derived from what an external's loader read", () => {
  test("a routed external whose loader read nothing captures only before its first run", async () => {
    const { h, r, cap } = routedExternal([]);
    await h.subscribe("msg");
    expect(cap.calls()).toBe(1); // nothing captured yet: it may read
    for (let i = 0; i < 5; i++) {
      r.notify();
      await tick();
    }
    expect(h.pushesFor("msg")).toHaveLength(5); // every push still ships …
    expect(cap.calls()).toBe(1); // … with no xmin round trip
    expect(h.pushesFor("msg").every((f) => !("watermark" in f))).toBe(true);
  });

  test("a routed external whose loader reads a table keeps capturing", async () => {
    const { h, r, cap } = routedExternal(["conversations"]);
    await h.subscribe("msg");
    r.notify();
    await tick();
    expect(cap.calls()).toBe(2);
    expect(h.pushesFor("msg")[0]!.watermark).toBeDefined();
  });
});

describe("watermark capture — one round trip per wave", () => {
  test("concurrent flights of different keys share one capture", async () => {
    let calls = 0;
    let release!: () => void;
    const h = createHarness({
      captureWatermark: () => {
        calls++;
        return new Promise<string>((resolve) => {
          release = () => resolve("42");
        });
      },
    });
    for (const key of ["a", "b", "c"]) {
      h.runtime.defineExternalResource({
        key,
        mode: "push",
        schema: z.string(),
        loader: async () => key,
      });
    }

    await h.subscribeBatch([{ key: "a" }, { key: "b" }, { key: "c" }]);
    expect(calls).toBe(1);
    release();
    await tick();
    const acks = h.frames.filter((f) => f.kind === "sub-ack");
    expect(acks.map((f) => f.value).sort()).toEqual(["a", "b", "c"]);
    for (const f of acks) expect(f.watermark).toBe("42");

    // Settled ⇒ released: the next flight captures afresh.
    h.runtime.defineExternalResource({
      key: "d",
      mode: "push",
      schema: z.string(),
      loader: async () => "d",
    });
    const sub = h.subscribe("d");
    await tick();
    expect(calls).toBe(2);
    release();
    await sub;
    await tick();
    expect(h.frames.find((f) => f.value === "d")!.watermark).toBe("42");
  });
});

describe("watermark capture — sharing never shares a failure", () => {
  test("a joiner whose shared capture rejected captures its own", async () => {
    let calls = 0;
    let fail!: () => void;
    const h = createHarness({
      captureWatermark: () => {
        calls++;
        if (calls === 1) {
          return new Promise<string>((_resolve, reject) => {
            fail = () => reject(new Error("capture failed"));
          });
        }
        return Promise.resolve(`${100 + calls}`);
      },
    });
    for (const key of ["a", "b"]) {
      h.runtime.defineExternalResource({
        key,
        mode: "push",
        schema: z.string(),
        loader: async () => key,
      });
    }

    await h.subscribeBatch([{ key: "a" }, { key: "b" }]);
    fail();
    await tick();
    await tick();
    const acks = h.frames.filter((f) => f.kind === "sub-ack");
    expect(acks).toHaveLength(2);
    // The starter ships tokenless (its own capture failed); the joiner retried.
    const stamped = acks.filter((f) => f.watermark !== undefined);
    expect(stamped).toHaveLength(1);
    expect(stamped[0]!.watermark).toBe("102");
  });
});

describe("version short-circuit — a notified revalidate resource keeps it", () => {
  test("a same-boot echo is answered up-to-date: no signature probe, no load", async () => {
    const h = createHarness();
    let loads = 0;
    let probes = 0;
    h.runtime.defineExternalResource({
      key: "cfg",
      mode: "push",
      schema: z.string(),
      loader: async () => {
        loads++;
        return "doc";
      },
      revalidate: async () => {
        probes++;
        return "sig";
      },
      freshness: { kind: "notified" },
    });

    await h.subscribe("cfg");
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect([loads, probes]).toEqual([1, 1]);

    await h.subscribe("cfg", {}, { version: ack.version, epoch: ack.epoch });
    expect(h.frames.some((f) => f.kind === "up-to-date")).toBe(true);
    expect([loads, probes]).toEqual([1, 1]);
  });

  test("another boot's echo falls to the ETag: a match answers up-to-date with no load", async () => {
    const h = createHarness();
    let loads = 0;
    h.runtime.defineExternalResource({
      key: "cfg",
      mode: "push",
      schema: z.string(),
      loader: async () => {
        loads++;
        return "doc";
      },
      revalidate: async () => "sig",
    });
    await h.subscribe("cfg");
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(loads).toBe(1);

    // A replay on a second socket (a fresh span), echoing a previous boot.
    const h2 = createHarness();
    let loads2 = 0;
    h2.runtime.defineExternalResource({
      key: "cfg",
      mode: "push",
      schema: z.string(),
      loader: async () => {
        loads2++;
        return "doc";
      },
      revalidate: async () => "sig",
      freshness: { kind: "notified" },
    });
    await h2.subscribe(
      "cfg",
      {},
      { version: ack.version, epoch: ack.epoch, etag: ack.etag as string },
    );
    expect(h2.frames.some((f) => f.kind === "up-to-date")).toBe(true);
    expect(loads2).toBe(0);
  });
});
