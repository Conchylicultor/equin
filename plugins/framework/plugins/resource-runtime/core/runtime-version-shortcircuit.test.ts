/**
 * Version short-circuit (bootEpoch) — the replay-storm cure. Run with
 * `bun test plugins/framework/plugins/resource-runtime/core/runtime-version-shortcircuit.test.ts`.
 *
 * A `sub` that echoes the (epoch, version) its cached value was produced under
 * is answered `up-to-date` from the in-memory per-pk version counter when the
 * epoch is THIS boot and the version matches — NO loader run, NO read-admission
 * slot. For a non-`revalidate` resource the version counter is its complete
 * change signal within one tracking span (every state change of a subscribed
 * tuple routes through flushNotifies, which bumps it), and every span opens with
 * a fresh version — so same-boot + same-version ⇒ the client's value is current.
 * This is what makes a chronic full-set sub replay cost ~0 instead of ~250 gated
 * loader runs per tab. See
 * research/perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md
 * Findings 2–3.
 *
 * Restrictions pinned here: wrong/absent epoch → full path (versions are
 * per-boot in-memory state, incomparable across restarts); version mismatch →
 * full path; `revalidate` resources are exempt (their freshness authority is
 * the ETag signature, whose truth may live outside the notify stream); a resub
 * after the tuple went N→0 is never short-circuited (its span is new). Every
 * short-circuit below is a resub on a socket that still holds the tuple. The
 * span rule itself — each way an untracked gap used to be answered
 * `up-to-date` — is pinned by `runtime-tracking-span.test.ts`.
 */

import { test, expect, describe, mock } from "bun:test";
import { z } from "zod";
import {
  createHarness,
  controllable,
  tick,
  makeClientView,
} from "./test-support";
import { defineRoutedTable } from "./testing/routed-fixture";

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));
const keyOf = (r: unknown) => (r as { id: string }).id;

describe("version short-circuit — same-boot epoch + matching version", () => {
  test("epoch+version match → up-to-date (with epoch), zero loader runs, zero gate slots", async () => {
    const onReadGateWait = mock((_ms: number) => {});
    const onSubShortCircuit = mock((_key: string) => {});
    const h = createHarness({ onReadGateWait, onSubShortCircuit });
    let loads = 0;
    const r = h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: async () => {
        loads++;
        return `val${loads}`;
      },
    });

    // Fresh sub → full sub-ack carrying the boot epoch (the client learns it)
    // and `base`, the fresh version the tuple's tracking span opened with.
    await h.subscribe("r");
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    const base = ack.version!;
    expect(typeof ack.epoch).toBe("string");
    expect(loads).toBe(1);

    // A notify advances the version to base + 1 (the client applies the update).
    r.notify();
    await tick();
    const update = h.frames.find((f) => f.kind === "update")!;
    expect(update.version).toBe(base + 1);
    expect(loads).toBe(2);

    // Replayed sub echoing (epoch, base + 1) on the socket that still holds the
    // tuple (same span) → up-to-date from memory: no loader run, no
    // read-admission slot (the gate's onWait never fired again), and the
    // short-circuit hook fired.
    const gateWaitsBefore = onReadGateWait.mock.calls.length;
    await h.subscribe("r", {}, { version: base + 1, epoch: ack.epoch });
    const utd = h.frames.find((f) => f.kind === "up-to-date")!;
    expect(utd.version).toBe(base + 1);
    expect(utd.epoch).toBe(ack.epoch);
    expect("value" in utd).toBe(false);
    expect(loads).toBe(2); // loader did NOT run
    expect(onReadGateWait.mock.calls.length).toBe(gateWaitsBefore); // gate untouched
    expect(onSubShortCircuit).toHaveBeenCalledTimes(1);
    expect(onSubShortCircuit).toHaveBeenCalledWith("r");
  });

  test("version match under a WRONG or ABSENT epoch → full sub-ack (loader runs)", async () => {
    const h = createHarness();
    let loads = 0;
    h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: async () => {
        loads++;
        return "val";
      },
    });

    await h.subscribe("r");
    const { version } = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(loads).toBe(1);

    // Wrong epoch (a previous boot's): the version matches, but the echo is
    // incomparable.
    await h.subscribe("r", {}, { version, epoch: "some-older-boot" });
    expect(loads).toBe(2);
    // Absent epoch (an old client): same.
    await h.subscribe("r", {}, { version });
    expect(loads).toBe(3);
    expect(h.frames.some((f) => f.kind === "up-to-date")).toBe(false);
    expect(h.frames.filter((f) => f.kind === "sub-ack")).toHaveLength(3);
  });

  test("version MISMATCH under the right epoch → full sub-ack at the current version", async () => {
    const h = createHarness();
    let loads = 0;
    const r = h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: async () => {
        loads++;
        return `val-${loads}`;
      },
    });

    await h.subscribe("r");
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    const base = ack.version!;
    r.notify(); // version → base + 1; the client that echoes `base` below is behind
    await tick();

    await h.subscribe("r", {}, { version: base, epoch: ack.epoch });
    const acks = h.frames.filter((f) => f.kind === "sub-ack");
    expect(acks).toHaveLength(2);
    expect(acks[1]!.version).toBe(base + 1); // served fresh at the current version
    expect(h.frames.some((f) => f.kind === "up-to-date")).toBe(false);
  });

  test("a revalidate resource IGNORES the version echo — its authority is the ETag", async () => {
    // The resource's truth may live outside the notify stream (git state), so a
    // matching version must not short-circuit; only a matching signature may.
    const h = createHarness();
    let loads = 0;
    h.runtime.defineExternalResource({
      key: "edited",
      mode: "invalidate",
      schema: z.string(),
      loader: async () => {
        loads++;
        return "val";
      },
      revalidate: async () => "sig-1",
    });

    await h.subscribe("edited");
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(loads).toBe(1);

    // Version+epoch match but a STALE etag → the full loader path (a sub-ack),
    // never the version short-circuit.
    await h.subscribe(
      "edited",
      {},
      { version: ack.version, epoch: ack.epoch, etag: "stale" },
    );
    expect(loads).toBe(2);
    expect(h.frames.filter((f) => f.kind === "sub-ack")).toHaveLength(2);
    expect(h.frames.some((f) => f.kind === "up-to-date")).toBe(false);
  });

  test("acks carry the boot epoch, stable across frames; _debug counts short-circuits per key", async () => {
    const h = createHarness();
    h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: async () => "val",
    });

    await h.subscribe("r");
    const { version, epoch } = h.frames.find((f) => f.kind === "sub-ack")!;
    await h.subscribe("r", {}, { version, epoch });
    await h.subscribe("r", {}, { version, epoch });
    const utds = h.frames.filter((f) => f.kind === "up-to-date");
    expect(utds).toHaveLength(2);
    for (const f of utds) expect(f.epoch).toBe(epoch); // one epoch per boot

    const res = await h.runtime.handleResourceHttp(
      new Request("http://localhost/api/resources/_debug"),
      { key: "_debug" },
    );
    const body = (await res.json()) as {
      resources: Array<{ key: string; subShortCircuits: number }>;
    };
    expect(body.resources.find((r) => r.key === "r")!.subShortCircuits).toBe(2);
  });

  test("HTTP path has NO version short-circuit — an invalidate refetch always gets a body", async () => {
    // The client's HTTP guard is strict-`<`: the normal invalidate-mode refetch
    // returns a body at an EQUAL version. A version short-circuit here would
    // starve that refetch, so the HTTP path deliberately never short-circuits.
    const h = createHarness();
    let loads = 0;
    h.runtime.defineExternalResource({
      key: "r",
      mode: "invalidate",
      schema: z.string(),
      loader: async () => {
        loads++;
        return "val";
      },
    });
    // The HTTP body carries `epoch: bootEpoch` — the same epoch the ack frames
    // carry (Fix B) — so the client can compare its cached version cross-boot. Grab
    // the ack epoch first, then reset `loads` so the HTTP no-short-circuit assertion
    // counts only the GET's own load.
    await h.subscribe("r");
    const ackEpoch = h.frames.find((f) => f.kind === "sub-ack")!.epoch!;
    loads = 0;
    const res = await h.runtime.handleResourceHttp(
      new Request("http://localhost/api/resources/r"),
      { key: "r" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      value: unknown;
      version: number;
      epoch: string;
    };
    expect(body.value).toBe("val");
    expect(body.epoch).toBe(ackEpoch);
    expect(loads).toBe(1);
  });
});

describe("keyed: an evicted snapshot is never left behind a short-circuit", () => {
  function keyedRows(failFull: () => boolean = () => false) {
    const h = createHarness();
    const ctl = controllable<{ id: string; n: number }[]>([
      { id: "a", n: 1 },
      { id: "b", n: 1 },
    ]);
    // A routed alias over the identity table (the shared fixture).
    const rows = defineRoutedTable(h, {
      key: "rows",
      table: "row_table",
      membership: "alias",
      schema: rowsSchema,
      orderOf: async () => ctl.value.map((row) => row.id),
      loader: (_p, c) => {
        if (c) return ctl.value.filter((row) => c.affectedIds.includes(row.id));
        if (failFull()) throw new Error("rows read failed");
        return ctl.loader();
      },
    });
    // A scoped UPDATE of row "a".
    const changeA = (n: number) => {
      ctl.setValue([
        { id: "a", n },
        { id: "b", n: 1 },
      ]);
      rows.feed("U", ["a"]);
    };
    return { h, changeA };
  }

  test("a resub after N→0 takes the full path: its sub-ack re-seeds the evicted snapshot, so the next change ships a scoped delta", async () => {
    // releaseSubRefcount evicts `snapshots` (not `versions`) on N→0. The resub
    // that follows opens a new tracking span with a fresh version, so the echo
    // of the old one cannot match: a full sub-ack, whose value re-seeds the
    // snapshot. (A short-circuit here used to skip that re-seed.)
    const { h, changeA } = keyedRows();
    await h.subscribe("rows");
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;

    await h.unsub("rows");
    await h.subscribe("rows", {}, { version: ack.version, epoch: ack.epoch });
    expect(h.frames.some((f) => f.kind === "up-to-date")).toBe(false);
    const acks = h.frames.filter((f) => f.kind === "sub-ack");
    expect(acks).toHaveLength(2);
    expect(acks[1]!.version).toBe(ack.version! + 1); // the new span's version

    // The snapshot is back, so a scoped change diffs against it: one upsert,
    // no FULL `update`.
    changeA(2);
    await tick();
    expect(h.frames.some((f) => f.kind === "update")).toBe(false);
    const deltas = h.pushesFor("rows").filter((f) => f.kind === "delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.upserts).toEqual([["a", { id: "a", n: 2 }]]);
    expect(deltas[0]!.version).toBe(acks[1]!.version! + 1);

    // The client converges to server truth across the whole frame history.
    const cv = makeClientView(keyOf);
    cv.applyAll(h.frames);
    expect(cv.value).toEqual([
      { id: "a", n: 2 },
      { id: "b", n: 1 },
    ]);
    expect(cv.version).toBe(acks[1]!.version! + 1);
    expect(cv.driftResubs).toBe(0);
  });

  test("a subscribed pk with no snapshot (its sub-ack load failed) self-heals — the next notify ships a FULL update", async () => {
    // The one way left for a subscribed keyed pk to hold no snapshot: its
    // sub-ack's load threw (`sub-error`), so nothing seeded it. A scoped change
    // then finds no base and the runtime reloads FULL, shipping a value-carrying
    // update (never a delta onto a missing base).
    let failFull = true;
    const { h, changeA } = keyedRows(() => failFull);
    await h.subscribe("rows");
    expect(h.frames.map((f) => f.kind)).toEqual(["sub-error"]);
    failFull = false;

    changeA(2);
    await tick();

    expect(h.frames.filter((f) => f.kind === "update")).toHaveLength(1);
    expect(h.frames.some((f) => f.kind === "delta")).toBe(false);
    const cv = makeClientView(keyOf);
    cv.applyAll(h.frames);
    expect(cv.value).toEqual([
      { id: "a", n: 2 },
      { id: "b", n: 1 },
    ]);
    expect(cv.driftResubs).toBe(0);
  });
});
