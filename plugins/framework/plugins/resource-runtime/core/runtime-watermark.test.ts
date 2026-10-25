/**
 * Commit watermark on the wire (Rule B′). Run with
 * `bun test plugins/framework/plugins/resource-runtime/core/runtime-watermark.test.ts`.
 *
 * The flight that produces a FULL value co-produces its commit watermark
 * (`opts.captureWatermark`, captured by the STARTER before `timedLoad` — see
 * `getResourceValue`), and the watermark rides ONLY the frames whose value fully
 * reconciles the client to server truth as of that capture: `sub-ack`, `update`,
 * FULL keyed deltas, and the HTTP body. A SCOPED delta (Layer-2 partial re-read)
 * and an M5 membership-scoped delta re-read only the affected rows, so stamping
 * one would let a client wrongly deny an optimistic op — they NEVER carry it.
 * `up-to-date` frames ship no value, so they carry none either. Twin of the
 * "etag rides only the update frame" rule. See
 * research/2026-07-11-global-never-revert-optimistic-edits.md (Rules B/B′).
 */

import { test, expect, describe, mock } from "bun:test";
import { z } from "zod";
import { createHarness, controllable, tick } from "./test-support";
import { feedChange, identityPlan } from "./testing/routed-fixture";

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));
const keyOf = (r: unknown) => (r as { id: string }).id;

// Keyed entries are routed over their identity table (the shared fixture's
// plan and change-feed delivery): scoped changes reach an entry only through
// its routes since P8 step 23a.

// A capture hook handing out strictly-increasing xid8-style decimal tokens, so
// each flight's watermark is distinguishable in the frame log.
function makeCapture(start = 100): {
  fn: () => Promise<string>;
  calls: () => number;
} {
  let next = start;
  let calls = 0;
  return {
    fn: async () => {
      calls++;
      return `${next++}`;
    },
    calls: () => calls,
  };
}

describe("watermark — full frames carry it", () => {
  test("sub-ack carries the flight watermark; a later update carries its own", async () => {
    let n = 0; // a new value on every recompute (an equal one ships nothing)
    const cap = makeCapture();
    const h = createHarness({ captureWatermark: cap.fn });
    const r = h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: async () => `val${++n}`,
    });

    await h.subscribe("r");
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(ack.watermark).toBe("100");

    r.notify();
    await tick();
    const update = h.frames.find((f) => f.kind === "update")!;
    expect(update.watermark).toBe("101");
  });

  test("up-to-date frames carry NO watermark (they ship no value)", async () => {
    const cap = makeCapture();
    const h = createHarness({ captureWatermark: cap.fn });
    h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: async () => "val",
    });

    await h.subscribe("r");
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    await h.subscribe("r", {}, { version: ack.version, epoch: ack.epoch });
    const utd = h.frames.find((f) => f.kind === "up-to-date")!;
    expect("watermark" in utd).toBe(false);
  });

  test("keyed: the FULL-recompute delta carries it; a SCOPED delta never does", async () => {
    const cap = makeCapture();
    const h = createHarness({
      captureWatermark: cap.fn,
    });
    let truth = [
      { id: "a", n: 1 },
      { id: "b", n: 1 },
    ];
    h.runtime.defineResource(
      {
        key: "rows",
        schema: rowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      {
        routes: identityPlan("row_table"),
        scopedMembership: {
          orderOf: async () => truth.map((r) => r.id),
          orderSignatureOf: () => "",
        },
        loader: (_p, c) =>
          c ? truth.filter((r) => c.affectedIds.includes(r.id)) : truth,
      },
    );
    await h.subscribe("rows"); // seeds snapshot; sub-ack carries a watermark
    expect(h.frames.find((f) => f.kind === "sub-ack")!.watermark).toBe("100");

    // Scoped UPDATE (Layer 2): a partial re-read — the delta MUST be tokenless.
    truth = [
      { id: "a", n: 2 },
      { id: "b", n: 1 },
    ];
    feedChange(h, {
      table: "row_table",
      op: "U",
      ids: ["a"],
    });
    await tick();
    const scoped = h.frames.filter((f) => f.kind === "delta").at(-1)!;
    expect(scoped.upserts).toHaveLength(1);
    expect("watermark" in scoped).toBe(false);

    // FULL recompute (id-less change): the delta fully reconciles → watermark.
    truth = [
      { id: "a", n: 3 },
      { id: "b", n: 1 },
    ];
    feedChange(h, {
      table: "row_table",
      op: "U",
      ids: null,
    });
    await tick();
    const full = h.frames.filter((f) => f.kind === "delta").at(-1)!;
    expect(full.watermark).toBe("101"); // the FULL flight's own capture
  });

  test("M5 membership-scoped deltas (in-place flip AND entry-with-order) never carry one", async () => {
    const cap = makeCapture();
    const h = createHarness({
      captureWatermark: cap.fn,
    });
    const table = new Map<string, number>();
    const rows = () => [...table.entries()].map(([id, n]) => ({ id, n }));
    h.runtime.defineResource(
      {
        key: "m",
        schema: rowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      {
        routes: identityPlan("m_table"),
        scopedMembership: {
          orderOf: async () => [...table.keys()],
          orderSignatureOf: () => "",
        },
        loader: (_p, c) =>
          c ? rows().filter((r) => c.affectedIds.includes(r.id)) : rows(),
      },
    );
    table.set("a", 1);
    await h.subscribe("m"); // seeds the membership snapshot

    // In-place flip (op U, no order asserted).
    table.set("a", 2);
    feedChange(h, {
      table: "m_table",
      op: "U",
      ids: ["a"],
    });
    await tick();
    const flip = h.frames.filter((f) => f.kind === "delta").at(-1)!;
    expect(flip.order).toBeUndefined();
    expect("watermark" in flip).toBe(false);

    // Membership entry (op I): the delta asserts the full `order` but is still
    // a partial re-read — it must stay tokenless.
    table.set("b", 1);
    feedChange(h, {
      table: "m_table",
      op: "I",
      ids: ["b"],
    });
    await tick();
    const entry = h.frames.filter((f) => f.kind === "delta").at(-1)!;
    expect(entry.order).toEqual(["a", "b"]);
    expect("watermark" in entry).toBe(false);
  });

  test("ackTx and watermark are independent: a scoped delta carries ackTx yet NEVER a watermark", async () => {
    // Rule B′ untouched by the ack channel: the scoped delta is still a partial
    // re-read (no snapshot-completeness claim, so no watermark), while ackTx —
    // a strictly narrower claim ("these transactions' rows were re-read") —
    // rides it fine.
    const cap = makeCapture();
    const h = createHarness({
      captureWatermark: cap.fn,
    });
    let truth = [{ id: "a", n: 1 }];
    h.runtime.defineResource(
      {
        key: "rows",
        schema: rowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      {
        routes: identityPlan("row_table"),
        scopedMembership: {
          orderOf: async () => truth.map((r) => r.id),
          orderSignatureOf: () => "",
        },
        loader: (_p, c) =>
          c ? truth.filter((r) => c.affectedIds.includes(r.id)) : truth,
      },
    );
    await h.subscribe("rows");

    truth = [{ id: "a", n: 2 }];
    feedChange(h, {
      table: "row_table",
      op: "U",
      ids: ["a"],
      xid: "77",
    });
    await tick();
    const scoped = h.frames.filter((f) => f.kind === "delta").at(-1)!;
    expect((scoped as { ackTx?: string[] }).ackTx).toEqual(["77"]);
    expect("watermark" in scoped).toBe(false);
  });

  test("HTTP body carries { value, version, epoch, watermark }", async () => {
    const cap = makeCapture();
    const h = createHarness({ captureWatermark: cap.fn });
    h.runtime.defineExternalResource({
      key: "r",
      mode: "invalidate",
      schema: z.string(),
      loader: async () => "val",
    });
    const res = await h.runtime.handleResourceHttp(
      new Request("http://localhost/api/resources/r"),
      { key: "r" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      value: unknown;
      version: number;
      epoch: string;
      watermark?: string;
    };
    expect(body.value).toBe("val");
    // `epoch: bootEpoch` rides every HTTP body (Fix B); it equals the ack epoch —
    // pinned in runtime-version-shortcircuit.test.ts (here we only assert its shape,
    // to avoid a subscribe consuming a makeCapture tick).
    expect(typeof body.epoch).toBe("string");
    expect(body.watermark).toBe("100");
  });
});

describe("watermark — degrade + adoption", () => {
  test("a THROWING captureWatermark still delivers the frame, tokenless, and reports", async () => {
    const reportError = mock((_ctx: string, _err: unknown) => {});
    const h = createHarness({
      captureWatermark: async () => {
        throw new Error("wm boom");
      },
      reportError,
    });
    h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: async () => "val",
    });

    await h.subscribe("r");
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(ack.value).toBe("val"); // the value still ships
    expect("watermark" in ack).toBe(false); // tokenless degrade
    expect(
      reportError.mock.calls.some(([ctx]) =>
        String(ctx).includes("watermark capture failed"),
      ),
    ).toBe(true);
  });

  test("a JOINER adopts the starter's watermark — one capture per coalesced flight", async () => {
    const cap = makeCapture();
    const ctl = controllable("val");
    const h = createHarness({ sockets: 2, captureWatermark: cap.fn });
    h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: ctl.loader,
    });

    // Park the loader so the second sub joins the first sub's in-flight load.
    ctl.block();
    const p1 = h.subscribe("r", {}, { socket: 0 });
    const p2 = h.subscribe("r", {}, { socket: 1 });
    ctl.release();
    await p1;
    await p2;

    const acks = h.frames.filter((f) => f.kind === "sub-ack");
    expect(acks).toHaveLength(2);
    // Both acks stamp the STARTER's capture; the joiner never captured its own.
    expect(acks[0]!.watermark).toBe("100");
    expect(acks[1]!.watermark).toBe("100");
    expect(cap.calls()).toBe(1);
  });

  test("no captureWatermark hook (central) → no frame and no HTTP body carries one", async () => {
    const h = createHarness();
    const r = h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: async () => "val",
    });

    await h.subscribe("r");
    r.notify();
    await tick();
    for (const f of h.frames) expect("watermark" in f).toBe(false);

    const res = await h.runtime.handleResourceHttp(
      new Request("http://localhost/api/resources/r"),
      { key: "r" },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect("watermark" in body).toBe(false);
    // `epoch` is unconditional (independent of the captureWatermark hook).
    expect(typeof body.epoch).toBe("string");
  });
});
