/**
 * Flight freshness — a push may not be served by a read that began before the
 * change it is announcing. Run with
 * `bun test plugins/framework/plugins/resource-runtime/core/runtime-stale-flight.test.ts`.
 *
 * The 2026-08-08 incident: a page's freshly typed blocks vanished for ten minutes
 * under load. A push drain assigned `version = current + 1` and then COALESCED
 * onto a read flight already in the air — whose SELECT had run before the commit
 * the drain was announcing — and broadcast those pre-commit rows under the fresh
 * version. The client's only guard is numeric (`version <= entry.version` ⇒ drop),
 * so it applied them; and because the drain had already cleared its pending, no
 * path ever re-read. See
 * `research/2026-08-08-global-live-state-flight-freshness.md`.
 *
 * The fix is REFUSAL, not adoption: the version is the one stamp that cannot be
 * co-produced (it is minted before the read), so the drain passes its pending's
 * `lastNotifyAt` as `inflight`'s `notBefore` and a flight older than that is
 * superseded rather than joined. Read callers pass no floor, so the read path's
 * coalescing — and the gate-after-dedup replay-storm fix riding on it — is
 * untouched.
 *
 * EVERY test here uses `snapshotControllable`, never `controllable`. That is not
 * style: `controllable` resolves at release time, so a pre-commit and a
 * post-commit flight return the same value and the buggy runtime is
 * indistinguishable from the fixed one. That is precisely why
 * `runtime-ack-channel.test.ts` staged this exact race for months and read as
 * green.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import {
  createHarness,
  snapshotControllable,
  tick,
  makeClientView,
} from "./test-support";
import {
  defineRoutedTable,
  feedChange,
  wholeReach,
} from "./testing/routed-fixture";

const rowsSchema = z.array(z.object({ id: z.string(), n: z.number() }));
const keyOf = (r: unknown) => (r as { id: string }).id;

type Rows = { id: string; n: number }[];

const PRE: Rows = [{ id: "a", n: 1 }];
const POST: Rows = [
  { id: "a", n: 1 },
  { id: "b", n: 2 },
];

/**
 * A keyed resource (a routed alias over `s_table`, the shared fixture) whose
 * loader is a `snapshotControllable`, plus a recorder for
 * the runtime's stale-flight supersession hook. Socket 0 is the established
 * subscriber (its snapshot is seeded on subscribe); socket 1 is the one that
 * parks a read flight in the middle.
 */
function staleFlightHarness(extra: Parameters<typeof createHarness>[0] = {}) {
  const ctl = snapshotControllable<Rows>(PRE);
  const supersedes: string[] = [];
  const h = createHarness({
    sockets: 2,
    onStaleFlightSupersede: (key) => supersedes.push(key),
    ...extra,
  });
  const s = defineRoutedTable(h, {
    key: "s",
    table: "s_table",
    membership: "alias",
    schema: rowsSchema,
    orderOf: async () => ctl.value.map((r) => r.id),
    loader: (_p, c) =>
      c ? ctl.value.filter((r) => c.affectedIds.includes(r.id)) : ctl.loader(),
  });
  // The incident's own change shape: `ids: null` — a FULL-absorbing merge, which
  // is why `lastNotifyAt` must be stamped BEFORE `mergePending`'s FULL-absorb
  // early return.
  const feedFull = () => s.feed("U", null);
  return { h, ctl, supersedes, feedFull };
}

describe("stale-flight refusal — the 2026-08-08 revert", () => {
  test("a push does not ship rows read before the commit it announces: the client converges to the POST-commit value", async () => {
    const { h, ctl, supersedes, feedFull } = staleFlightHarness();
    await h.subscribe("s", {}, { socket: 0 }); // established sub; snapshot = PRE

    // Socket 1 opens a read flight that SELECTs the pre-commit rows and then
    // parks — the slow loader of the incident (8–15 s spans were routine).
    ctl.block();
    const parked = h.subscribe("s", {}, { socket: 1 });
    await tick(); // the read flight is now in the air, holding the PRE rows
    expect(ctl.invocations).toBe(2); // sub 0 (already settled) + the parked read

    // The commit lands DURING that flight, and the feed delivers it.
    ctl.setValue(POST);
    feedFull();
    await tick(); // the drain runs: it must refuse the parked flight

    expect(supersedes).toEqual(["s"]); // refused, and counted
    expect(ctl.invocations).toBe(3); // …by starting its own read, which sees POST

    ctl.release();
    await parked;
    await tick();

    // Socket 0 — the established subscriber, the incident's browser — converges
    // to the post-commit rows.
    const cv = makeClientView(keyOf);
    cv.applyAll(h.framesFor(0));
    expect(cv.value).toEqual(POST);
    expect(cv.driftResubs).toBe(0);

    // PRE-FIX, this test does not merely fail on a value — it finds NO FRAME AT
    // ALL. The drain would have joined the parked flight, whose value equals the
    // snapshot socket 0's sub-ack seeded, so `diffKeyedFull` comes back empty and
    // the runtime correctly sends nothing for an empty diff. The version was
    // already minted and the pending already cleared, so nothing re-read: the
    // client sits on the pre-commit rows until an unrelated later write to the
    // same tuple. That is the ten-minute stall, and it is why the assertion below
    // is `>= 1` rather than a shape — the bug's signature is silence.
    expect(h.pushesFor("s", 0).length).toBeGreaterThanOrEqual(1);
  });

  test("version/value pairing: no frame carrying version N carries a value read before the commit that produced N", async () => {
    const { h, ctl, feedFull } = staleFlightHarness();
    await h.subscribe("s", {}, { socket: 0 });
    // The version this tuple's tracking span opened with (socket 0 was its
    // first subscriber). Socket 1 joins the same span, so it reports it too.
    const base = h.frames.find((f) => f.kind === "sub-ack")!.version!;

    ctl.block();
    const parked = h.subscribe("s", {}, { socket: 1 });
    // Load-bearing: without this yield the parked sub has not reached its loader
    // yet, so it would capture POST and there would be no pre-commit flight to
    // refuse — the test would pass against the UNFIXED runtime. (It did, until
    // this line was added.)
    await tick();
    ctl.setValue(POST);
    feedFull();
    await tick();
    ctl.release();
    await parked;
    await tick();

    // Version `base` is the pre-commit state (both sub-acks report it — a READ
    // frame reports a version observed before its load, so a pre-commit value
    // can only ever ride an equally old version). Version `base + 1` is minted BY
    // the commit, and every frame carrying it must carry rows that reflect it.
    const cv = makeClientView(keyOf);
    for (const frame of h.framesFor(0)) {
      cv.apply(frame);
      if (frame.version === base + 1) {
        // Applying every such frame in order must leave the client at POST — the
        // frame asserted "this is the state as of the change", so it has to be.
        expect(cv.value).toEqual(POST);
      }
    }
    expect(h.framesFor(0).some((f) => f.version === base + 1)).toBe(true);
  });

  test("a drain does NOT supersede a flight that started after its own notify (the floor is `notBefore`, not `never join`)", async () => {
    // The floor refuses only flights OLDER than the notify. A flight that began
    // after it cannot have missed the commit, so the drain joins it and the
    // loader runs once — the property `notBefore` exists to preserve, and the
    // reason the fix is a floor rather than "the push path never coalesces".
    // Staged with a debounced entry: the notify arms a timer instead of the
    // immediate microtask flush, which opens the window for a read flight to
    // start between the notify and the drain.
    const ctl = snapshotControllable<Rows>(PRE);
    const supersedes: string[] = [];
    const h = createHarness({
      sockets: 2,
      onStaleFlightSupersede: (key) => supersedes.push(key),
    });
    const r = h.runtime.defineExternalResource({
      key: "d",
      mode: "push",
      schema: rowsSchema,
      debounceMs: 5,
      loader: ctl.loader,
    });
    await h.subscribe("d", {}, { socket: 0 });
    const before = ctl.invocations;

    ctl.setValue(POST);
    r.notify(); // stamps lastNotifyAt; the flush is deferred by the debounce
    ctl.block();
    const parked = h.subscribe("d", {}, { socket: 1 }); // starts AFTER the notify
    await tick();
    expect(ctl.invocations).toBe(before + 1);

    await new Promise((res) => setTimeout(res, 15)); // the debounce fires
    expect(supersedes).toEqual([]); // the flight is fresh enough — joined
    expect(ctl.invocations).toBe(before + 1); // exactly one loader run, shared

    ctl.release();
    await parked;
    await tick();
    const cv = makeClientView();
    cv.applyAll(h.framesFor(0));
    expect(cv.value).toEqual(POST);
  });

  test("per-tuple loader concurrency never exceeds 2 under supersession", async () => {
    // Supersession runs a second body rather than chaining behind the stale one,
    // so the bound has to be argued, not assumed: only a DRAIN supersedes, drains
    // for one (key, pk) are serialised by the flush mutex plus the sequential
    // per-pk loop, and a drain awaits its own flight. So at most one superseded
    // flight and one superseding flight are in the air at once.
    const ctl = snapshotControllable<Rows>(PRE);
    let live = 0;
    let maxLive = 0;
    const h = createHarness({ sockets: 3 });
    const s = defineRoutedTable(h, {
      key: "s",
      table: "s_table",
      membership: "alias",
      schema: rowsSchema,
      orderOf: async () => ctl.value.map((row) => row.id),
      loader: async (_p, c) => {
        if (c) return ctl.value.filter((row) => c.affectedIds.includes(row.id));
        live++;
        maxLive = Math.max(maxLive, live);
        try {
          return await ctl.loader();
        } finally {
          live--;
        }
      },
    });
    await h.subscribe("s", {}, { socket: 0 });

    ctl.block();
    const p1 = h.subscribe("s", {}, { socket: 1 });
    const p2 = h.subscribe("s", {}, { socket: 2 }); // joins p1's flight
    ctl.setValue(POST);
    // Three FULL changes back to back: each drain refuses whatever is older than
    // its own notify. They still cannot overlap each other.
    for (let i = 0; i < 3; i++) {
      s.feed("U", null);
      await tick();
    }
    ctl.release();
    await Promise.all([p1, p2]);
    await tick();

    expect(maxLive).toBeLessThanOrEqual(2);
  });

  test("a value-aware cascade `map(params, value)` receives the POST-commit value", async () => {
    // The cascade reads the drained value directly, so a joined pre-commit value
    // would propagate the stale state into every downstream tuple selection —
    // the same bug one hop further out, and invisible on the wire. A cascade
    // upstream is external (T15) and non-keyed; here one declaring its
    // table read (a reach plan).
    const ctl = snapshotControllable<Rows>(PRE);
    const seen: Rows[] = [];
    const h = createHarness({ sockets: 2 });
    const up = h.runtime.defineExternalResource(
      { key: "s", schema: rowsSchema, validateParams: () => {} },
      {
        mode: "push",
        reach: wholeReach(["s_table"]),
        loader: () => ctl.loader(),
      },
    );
    h.runtime.defineResource({
      key: "down",
      mode: "push",
      schema: z.number(),
      loader: async () => 0,
      dependsOn: [
        {
          resource: up,
          map: (_p: unknown, value: unknown) => {
            seen.push((value ?? []) as Rows);
            return [{}];
          },
        },
      ],
    });
    await h.subscribe("s", {}, { socket: 0 });

    ctl.block();
    const parked = h.subscribe("s", {}, { socket: 1 });
    // Load-bearing, same reason as the version/value-pairing case: the parked
    // read must actually be in the air holding PRE before the commit lands, or
    // there is no stale flight for the drain to refuse and the case passes
    // against the UNFIXED runtime.
    await tick();
    ctl.setValue(POST);
    feedChange(h, { table: "s_table", op: "U", ids: null });
    await tick();
    ctl.release();
    await parked;
    await tick();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(POST); // never the parked flight's PRE rows
  });

  test("read paths still coalesce: two subscribers of one tuple run the loader once", async () => {
    // The guard against over-applying the floor. A read frame only REPORTS a
    // version it observed before its load, so an older joined value can only
    // report an older version — which the client drops. Passing a floor here
    // would strip the gate-after-dedup coalescing that the boot-snapshot fan-out
    // and the multi-tab sub herd depend on.
    const { h, ctl, supersedes } = staleFlightHarness({ sockets: 3 });
    ctl.block();
    const a = h.subscribe("s", {}, { socket: 0 });
    const b = h.subscribe("s", {}, { socket: 1 });
    await tick();
    expect(ctl.invocations).toBe(1); // one flight, two callers
    ctl.release();
    await Promise.all([a, b]);
    expect(ctl.invocations).toBe(1);
    expect(supersedes).toEqual([]);
  });

  test("termination: a notify racing the supersession decision does not spin — loader invocations stay bounded", async () => {
    // Supersession starts a fresh flight, which a later drain could in turn
    // supersede. The bound is one hop per notify: a drain refuses at most the one
    // flight holding the key, and its own flight satisfies every floor stamped
    // before it started. Ten notifies interleaved with the parked flight must
    // therefore cost a bounded number of loads, not an unbounded chain.
    const { h, ctl, feedFull } = staleFlightHarness();
    await h.subscribe("s", {}, { socket: 0 });

    ctl.block();
    const parked = h.subscribe("s", {}, { socket: 1 });
    const before = ctl.invocations;
    for (let i = 0; i < 10; i++) {
      ctl.setValue([{ id: "a", n: i }]);
      feedFull();
      await tick();
    }
    ctl.release();
    await parked;
    await tick();

    // At most one fresh flight per drain, and no re-entrant chain: well under the
    // 10 notifies' worth of runaway a spin would produce.
    expect(ctl.invocations - before).toBeLessThanOrEqual(10);
    expect(ctl.invocations).toBeGreaterThan(before); // it did refuse at least once
  });
});

describe("stale-flight refusal — the L2 persist floor", () => {
  test("the persisted (value, watermark) pair is co-produced: the floor describes the commit the value reflects", async () => {
    // The worst instance of the class, because it survives a restart. Catch-up
    // replays only `xid >= watermark`, so a pre-commit value floored by a
    // post-commit watermark makes cold boot skip the very commit the value is
    // missing — permanently. The watermark here is tied to the truth it was
    // captured over, so a mismatched pair is directly observable.
    const ctl = snapshotControllable<Rows>(PRE);
    let truthTag = "pre";
    const persistArgs: Array<{ value: unknown; wm: string }> = [];
    const h = createHarness({
      sockets: 2,
      shouldPersist: (k) => k === "s",
      captureWatermark: async () => `xmin-${truthTag}`,
      persistSnapshot: async (_key, _pk, value, wm) => {
        persistArgs.push({ value, wm });
      },
    });
    const s = defineRoutedTable(h, {
      key: "s",
      table: "s_table",
      membership: "alias",
      schema: rowsSchema,
      orderOf: async () => ctl.value.map((r) => r.id),
      loader: () => ctl.loader(),
    });
    await h.subscribe("s", {}, { socket: 0 });
    persistArgs.length = 0; // ignore the subscribe-time recompute, if any

    ctl.block();
    const parked = h.subscribe("s", {}, { socket: 1 });
    // Load-bearing yield (see the version/value-pairing case): only after it the
    // parked read has really captured PRE + `xmin-pre`. Without it the flight
    // starts after the commit, there is nothing stale to refuse, and this case
    // passes against the UNFIXED runtime.
    await tick();
    ctl.setValue(POST);
    truthTag = "post";
    s.feed("U", null);
    await tick();
    ctl.release();
    await parked;
    await tick();

    expect(persistArgs).toHaveLength(1);
    // The pair, not either half: POST rows floored by the watermark captured over
    // POST. `xmin-pre` beside POST rows would be an under-floor (harmless
    // over-replay); `xmin-post` beside PRE rows is the durable stale boot.
    expect(persistArgs[0]!.value).toEqual(POST);
    expect(persistArgs[0]!.wm).toBe("xmin-post");
  });
});
