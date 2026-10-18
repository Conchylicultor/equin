/**
 * Conditional revalidation (ETag / 304) — the read-path invariant. Run with
 * `bun test plugins/framework/plugins/resource-runtime/core/runtime-revalidate.test.ts`.
 *
 * `revalidate` lets a resource answer "is what you already have still current?"
 * with a cheap content signature (an ETag) BEFORE running the full loader: on a
 * match the server replies `up-to-date` (WS) / `304` (HTTP) and the client keeps
 * its cached value. These suites pin both the happy path (hit / miss / stamp /
 * fail-safe) and — the load-bearing one — that the stamped ETag never reflects a
 * state NEWER than the value it accompanies.
 *
 * The ordering invariant (see `handleSub` / `handleResourceHttp`): the ETag is
 * computed BEFORE the value. Computed AFTER (the pre-fix bug, commit 55fb39beb),
 * a change landing between the value read and the etag read would ship a stale
 * value stamped with an already-current ETag; a later resubscribe would then be
 * answered `up-to-date`/`304` and keep the stale value forever — and for an
 * `invalidate`-mode resource (e.g. edited-files) nothing heals it, since an
 * invalidate push carries no value. The REGRESSION test below reproduces exactly
 * that race and asserts convergence to current server truth.
 */

import { test, expect, describe, mock } from "bun:test";
import { hashHex } from "@plugins/packages/plugins/string-hash/core";
import { ResourceRefusal } from "@plugins/packages/plugins/resource-protocol/core";
import { z } from "zod";
import { mintReachPlan } from "./routing";
import {
  createHarness,
  controllable,
  tick,
  makeClientView,
} from "./test-support";
import type { RecordedFrame } from "./test-support";

// The runtime hashes every `revalidate` signature (`normalizeEtag`, string-hash's `hashHex`) so the
// wire ETag is opaque and header-safe. Mirror it here to name the expected token.
const sig = (raw: string): string => hashHex(raw);

const httpReq = (key: string, ifNoneMatch?: string): Request =>
  new Request(`http://localhost/api/resources/${key}`, {
    headers: ifNoneMatch !== undefined ? { "If-None-Match": ifNoneMatch } : {},
  });

describe("conditional revalidation — read path (ETag / 304)", () => {
  test("up-to-date hit (WS): a matching client etag short-circuits — no loader run, client keeps its cached value", async () => {
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
      revalidate: async () => "sig-1",
    });

    // Fresh sub (no etag) primes the client with value + the current signature.
    await h.subscribe("r");
    const firstAck = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(firstAck.value).toBe("val");
    expect(firstAck.etag).toBe(sig("sig-1"));
    expect(loads).toBe(1);

    // Resub on the SAME socket with the matching etag → `up-to-date`, no loader.
    await h.subscribe("r", {}, { etag: firstAck.etag });
    const utd = h.frames.find((f) => f.kind === "up-to-date");
    expect(utd).toBeDefined();
    expect("value" in utd!).toBe(false); // an up-to-date frame carries no value
    expect(loads).toBe(1); // loader did NOT run again

    // The real client, fed both frames, still holds the cached value.
    const cv = makeClientView();
    cv.applyAll(h.framesFor(0));
    expect(cv.value).toBe("val");
  });

  test("etag miss (WS): a stale client etag runs the loader and re-stamps a fresh etag", async () => {
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
      revalidate: async () => "sig-2",
    });

    await h.subscribe("r", {}, { etag: "stale-etag" });
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(ack.value).toBe("val");
    expect(ack.etag).toBe(sig("sig-2"));
    expect(ack.etag).not.toBe("stale-etag");
    expect(loads).toBe(1);
    expect(h.frames.some((f) => f.kind === "up-to-date")).toBe(false);
  });

  test("fresh sub, no etag (WS): the sub-ack carries value + a fresh etag", async () => {
    const h = createHarness();
    h.runtime.defineExternalResource({
      key: "r",
      mode: "invalidate",
      schema: z.string(),
      loader: async () => "val",
      revalidate: async () => "sig",
    });

    await h.subscribe("r");
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(ack.value).toBe("val");
    expect("etag" in ack).toBe(true);
    expect(ack.etag).toBe(sig("sig"));
  });

  test("REGRESSION — value/etag skew: the stamped ETag never reflects a state newer than the value it accompanies", async () => {
    // The reported bug. A resource whose value load starts before a change lands
    // but whose ETag is computed after: the sub-ack ships a STALE value stamped
    // with an ALREADY-CURRENT etag, and a later resubscribe is then answered
    // `up-to-date` and keeps the stale value forever (invalidate mode carries no
    // healing value on a push).
    //
    // Model: `gitState` is the cheap etag signal; the loader is a `controllable()`
    // whose in-flight load reflects the PRE-change snapshot ("v1"). During the
    // parked load, a change lands (gitState 1→2) — the etag signal advances but the
    // in-flight value does not. After it releases, the loader would (on a re-run)
    // see the post-change truth ("v2").
    //
    // With the FIX (etag BEFORE value): the sub-ack stamps etag "1" — no newer
    // than the value's state 1 — so a resub with "1" mismatches the now-current
    // "2", forces a real load, and converges to "v2".
    // With the pre-fix ordering (etag AFTER value): the sub-ack would stamp etag
    // "2" against the stale "v1"; the resub with "2" would match and be answered
    // `up-to-date`, pinning "v1" forever — this test would then FAIL at the final
    // convergence assert.
    const h = createHarness({ sockets: 2 });
    let gitState = 1;
    const ctl = controllable("v1"); // the in-flight load returns the pre-change snapshot
    h.runtime.defineExternalResource({
      key: "edited",
      mode: "invalidate",
      schema: z.string(),
      loader: ctl.loader,
      revalidate: async () => String(gitState),
    });

    // Subscribe with the loader parked. In the fixed path the etag ("1") is
    // captured here, BEFORE the value and BEFORE the change below.
    ctl.block();
    await h.subscribe("edited", {}, { socket: 0 });
    expect(h.frames).toHaveLength(0); // nothing sent — parked on the loader

    gitState = 2; // a change lands DURING the load (the etag signal advances)
    ctl.release();
    await tick(); // loader resumes → returns the pre-change "v1"; sub-ack is sent
    ctl.setValue("v2"); // a re-run of the loader would now see the post-change truth

    const ack = h.frames.find((f) => f.socket === 0 && f.kind === "sub-ack")!;
    expect(ack.value).toBe("v1"); // the pre-change snapshot (an unavoidable load race)
    // The load-bearing assertion: the etag reflects state 1 (the value's state),
    // NOT the post-change state 2. Computed-after-value, this would be sig("2").
    expect(ack.etag).toBe(sig("1"));

    // Post-restart resubscribe with the stored etag on a fresh socket. The server
    // must NOT answer `up-to-date` (which would pin the stale "v1"); it re-loads
    // and converges the client to current truth "v2".
    await h.subscribe("edited", {}, { socket: 1, etag: ack.etag });
    const resub = h.frames.find(
      (f) =>
        f.socket === 1 && (f.kind === "sub-ack" || f.kind === "up-to-date"),
    )!;
    expect(resub.kind).toBe("sub-ack"); // re-load, NOT an up-to-date short-circuit
    expect(resub.value).toBe("v2"); // converged to current server truth
    expect(resub.etag).toBe(sig("2")); // and re-stamped with the now-current signature
  });

  test("HTTP 304 path: matching If-None-Match → 304 (empty body, no loader); mismatch/absent → 200 + ETag", async () => {
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
      revalidate: async () => "sig",
    });

    // Matching If-None-Match → 304, empty body, loader NOT run.
    const res304 = await h.runtime.handleResourceHttp(
      httpReq("r", sig("sig")),
      { key: "r" },
    );
    expect(res304.status).toBe(304);
    expect(await res304.text()).toBe("");
    expect(loads).toBe(0);

    // Absent If-None-Match → 200 with {value,version} and a fresh ETag header.
    const res200 = await h.runtime.handleResourceHttp(httpReq("r"), {
      key: "r",
    });
    expect(res200.status).toBe(200);
    expect(res200.headers.get("ETag")).toBe(sig("sig"));
    const body = (await res200.json()) as { value: unknown; version: number };
    expect(body.value).toBe("val");
    expect(body.version).toBe(0);
    expect(loads).toBe(1);

    // Mismatching If-None-Match → 200 (a real body), not 304.
    const resMiss = await h.runtime.handleResourceHttp(
      httpReq("r", sig("stale")),
      { key: "r" },
    );
    expect(resMiss.status).toBe(200);
    expect(resMiss.headers.get("ETag")).toBe(sig("sig"));
    expect(loads).toBe(2);
  });

  test("revalidate throws → fail-safe: value still delivered, NO etag stamped, never 304 / up-to-date", async () => {
    // computeEtag catches a throwing signature and returns undefined; the read
    // path then degrades to the plain full-loader behavior and never serves a
    // conditional short-circuit. (The runtime's own console.error fires here.)
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
      revalidate: async () => {
        throw new Error("signature boom");
      },
    });

    // WS: even with a client etag, the throw means no up-to-date — a full sub-ack
    // with value and NO etag.
    await h.subscribe("r", {}, { etag: "anything" });
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(ack.value).toBe("val");
    expect("etag" in ack).toBe(false);
    expect(h.frames.some((f) => f.kind === "up-to-date")).toBe(false);
    expect(loads).toBe(1);

    // HTTP: an If-None-Match cannot 304 through a broken signature; 200 with the
    // value and NO ETag response header.
    const res = await h.runtime.handleResourceHttp(httpReq("r", "anything"), {
      key: "r",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeNull();
    const body = (await res.json()) as { value: unknown; version: number };
    expect(body.value).toBe("val");
    expect(loads).toBe(2);
  });

  test("version adoption after up-to-date: a later higher-version frame applies; equal/lower is dropped", () => {
    // The client-guard contract the server's up-to-date frames lean on: an
    // up-to-date adopts the reported version while KEEPING the cached value, so a
    // subsequent genuine update/invalidate at a strictly-higher version still
    // applies (never stale-dropped), and an equal-or-lower one is dropped by the
    // WS version guard (`frame.version > version`). Driven through the real client
    // simulator so it mirrors `notifications-client.ts`.
    const cv = makeClientView();
    const frame = (over: Partial<RecordedFrame>): RecordedFrame =>
      ({ seq: 0, socket: 0, key: "r", ...over }) as RecordedFrame;

    cv.apply(frame({ kind: "sub-ack", value: "v0", version: 5 }));
    expect(cv.value).toBe("v0");
    expect(cv.version).toBe(5);

    // up-to-date at a HIGHER version (a restart advanced the server counter):
    // adopt the version, keep the cached value.
    cv.apply(frame({ kind: "up-to-date", version: 7 }));
    expect(cv.version).toBe(7);
    expect(cv.value).toBe("v0");

    // A genuine higher-version update applies — not stale-dropped by the adopted 7.
    cv.apply(frame({ kind: "update", value: "v1", version: 8 }));
    expect(cv.version).toBe(8);
    expect(cv.value).toBe("v1");

    // An equal-version update is dropped by the guard (8 is not > 8).
    cv.apply(frame({ kind: "update", value: "vX", version: 8 }));
    expect(cv.version).toBe(8);
    expect(cv.value).toBe("v1");

    // A lower-version invalidate is dropped — no stale flag, no version regression.
    cv.apply(frame({ kind: "invalidate", version: 2 }));
    expect(cv.version).toBe(8);
    expect(cv.value).toBe("v1");
    expect(cv.stale).toBe(false);
  });
});

/**
 * Same-flight co-production — the invariant the ordering rule above is only half of.
 *
 * Ordering (etag BEFORE value) is sufficient only if reading the value at time T
 * yields the state at T. Two things break that premise, and only the second is
 * fixable inside this runtime:
 *
 *   - the loader answers from a MEMO whose as-of time lags its call time;
 *   - the load COALESCES onto another caller's in-flight run (`getResourceValue`
 *     single-flights full loads per `(key, params)`).
 *
 * Under coalescing, two `handleSub`s that probed their own signatures either side
 * of a change share ONE loader run: the joiner receives the starter's older value
 * and — pre-fix — stamped its OWN newer etag on the sub-ack. The client then holds
 * `(V@S1, S2)`; its next revalidation sends S2, matches, is answered
 * `up-to-date`/`304`, and for an `invalidate`-mode resource (whose pushes carry no
 * value) nothing ever heals it. Permanently pinned.
 *
 * The cure: the flight carries the etag. `gatedRead(entry, params, freshEtag)`
 * offers the caller's signature as a SEED; `createInflight` runs the factory only
 * for the starter, so joiners receive the starter's `{value, etag}` object and
 * adopt its seed, discarding their own. Callers stamp the RETURNED etag. An etag
 * describing a snapshot OLDER than its value costs one needless recompute; a newer
 * one serves stale forever.
 */
describe("conditional revalidation — value and etag are co-produced by one flight", () => {
  test("memo skew: a fresh etag over a stale memoized value must not pin", async () => {
    // Models the real `edited-files` shape: `revalidate` probes git directly
    // (instantaneously fresh), while the loader answers from a watcher-populated
    // memo that lags it. Here `gitState` is the signature authority and `memoValue`
    // is the lagging loader authority — two clocks, independently controlled.
    //
    // A flight is parked holding the pre-change memo value "v1". `gitState` then
    // advances 1→2. A second subscriber probes the NEW signature and coalesces onto
    // that parked flight — so it receives "v1" while holding sig("2") in hand.
    //
    // The load-bearing assertion: no sub-ack anywhere pairs the stale value "v1"
    // with the newer signature sig("2"). Pre-fix, the joiner's ack does exactly
    // that, and the resub below is answered `up-to-date` — the permanent pin.
    const h = createHarness({ sockets: 3 });
    let gitState = 1;
    const memo = controllable("v1"); // the loader's own (lagging) authority
    h.runtime.defineExternalResource({
      key: "edited",
      mode: "invalidate",
      schema: z.string(),
      loader: memo.loader,
      revalidate: async () => String(gitState),
    });

    memo.block(); // park the flight mid-load, holding the pre-change snapshot
    await h.subscribe("edited", {}, { socket: 0 }); // probes sig("1"), starts the flight
    expect(h.frames).toHaveLength(0);

    gitState = 2; // the change lands: the signature authority advances, the memo does not
    await h.subscribe("edited", {}, { socket: 1 }); // probes sig("2"), coalesces onto the flight
    expect(h.frames).toHaveLength(0);

    memo.release();
    await tick();

    const acks = h.frames.filter((f) => f.kind === "sub-ack");
    expect(acks).toHaveLength(2);
    for (const ack of acks) expect(ack.value).toBe("v1"); // one shared flight, one value
    // Neither subscriber may hold the stale value under the post-change signature.
    expect(acks.some((a) => a.value === "v1" && a.etag === sig("2"))).toBe(
      false,
    );

    // And the pin cannot form: whatever etag the joiner stored, its next
    // revalidation must NOT be short-circuited while its value is stale.
    const joinerAck = h.frames.find(
      (f) => f.socket === 1 && f.kind === "sub-ack",
    )!;
    await h.subscribe("edited", {}, { socket: 2, etag: joinerAck.etag });
    const resub = h.frames.find(
      (f) =>
        f.socket === 2 && (f.kind === "sub-ack" || f.kind === "up-to-date"),
    )!;
    expect(resub.kind).toBe("sub-ack"); // a real reload, never `up-to-date`
  });

  test("coalescing: a joiner adopts the starter's etag, never its own newer one", async () => {
    // The mechanism, asserted directly. Same parked-flight setup; this time we name
    // the exact token both acks must carry and prove the client converges.
    const h = createHarness({ sockets: 3 });
    let gitState = 1;
    const ctl = controllable("v1");
    h.runtime.defineExternalResource({
      key: "edited",
      mode: "invalidate",
      schema: z.string(),
      loader: ctl.loader,
      revalidate: async () => String(gitState),
    });

    ctl.block();
    await h.subscribe("edited", {}, { socket: 0 }); // STARTER — probes "1"
    gitState = 2;
    await h.subscribe("edited", {}, { socket: 1 }); // JOINER — probes "2", coalesces
    ctl.release();
    await tick();
    ctl.setValue("v2"); // a re-run of the loader would now see post-change truth

    const starterAck = h.frames.find(
      (f) => f.socket === 0 && f.kind === "sub-ack",
    )!;
    const joinerAck = h.frames.find(
      (f) => f.socket === 1 && f.kind === "sub-ack",
    )!;
    expect(starterAck.value).toBe("v1");
    expect(joinerAck.value).toBe("v1"); // the starter's value — one loader run

    // BOTH stamp the STARTER's seed. The joiner's own sig("2") is discarded: it
    // names a snapshot the value it accompanies does not reflect.
    expect(starterAck.etag).toBe(sig("1"));
    expect(joinerAck.etag).toBe(sig("1"));

    // Consequently the joiner's stored etag mismatches the now-current "2" on its
    // next revalidation → a full reload → convergence to current server truth.
    await h.subscribe("edited", {}, { socket: 2, etag: joinerAck.etag });
    const resub = h.frames.find(
      (f) =>
        f.socket === 2 && (f.kind === "sub-ack" || f.kind === "up-to-date"),
    )!;
    expect(resub.kind).toBe("sub-ack");
    expect(resub.value).toBe("v2");
    expect(resub.etag).toBe(sig("2"));
  });

  test("a push-started flight joined by a read sub omits the etag", async () => {
    // `loadResourceByKey` (and every push-path caller) starts a flight with NO seed
    // — it has no signature to offer and none to report. A read subscriber that
    // coalesces onto it therefore gets `etag: undefined` back and must OMIT the etag
    // from its sub-ack, storing none client-side so its next revalidation does a full
    // load. Falling back to the subscriber's own `freshEtag` would stamp a signature
    // strictly newer than the value the flight produced — the same skew.
    const h = createHarness({ sockets: 1 });
    const ctl = controllable("v1");
    h.runtime.defineExternalResource({
      key: "edited",
      mode: "invalidate",
      schema: z.string(),
      loader: ctl.loader,
      revalidate: async () => "sig-1",
    });

    ctl.block();
    const pushLoad = h.runtime.loadResourceByKey("edited"); // starts the unseeded flight
    await h.subscribe("edited", {}, { socket: 0 }); // joins it
    expect(h.frames).toHaveLength(0);

    ctl.release();
    await tick();
    expect(await pushLoad).toBe("v1"); // the push-path caller still gets its bare value

    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(ack.value).toBe("v1");
    expect("etag" in ack).toBe(false); // no etag — never the joiner's own sig("sig-1")

    // The HTTP twin: a GET joining an unseeded flight stamps no `ETag` header.
    ctl.block();
    const pushLoad2 = h.runtime.loadResourceByKey("edited");
    const resP = h.runtime.handleResourceHttp(httpReq("edited"), {
      key: "edited",
    });
    await tick(); // let the GET probe its signature and coalesce onto the parked flight
    ctl.release();
    const res = await resP;
    await pushLoad2;
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeNull();
    const body = (await res.json()) as { value: unknown };
    expect(body.value).toBe("v1");
  });
});

/**
 * Push-path co-production — the etag rides the value-carrying `update` frame, and
 * nothing else.
 *
 * `pushEtag` has exactly ONE caller: `sendUpdate`, which builds AND broadcasts the
 * value-carrying `update` frame. So the etag is computed only where the value it
 * describes is actually shipped — the `invalidate` frame and every `delta` frame
 * structurally cannot obtain one (there is no other call site). Before this, both
 * drain paths hoisted `pushEtag` above the frame-kind branch and the non-`update`
 * branches silently discarded it; for an `invalidate` resource that was a full
 * signature recompute — for `edited-files`, a DB read + 3 git spawns + an lstat
 * per dirty file — thrown away on every notify. These cases pin the invariant on
 * every live-reachable push path (no keyed resource declares `revalidate`, and
 * `defineExternalResource` produces no keyed contract, so a keyed-delta case would
 * cost more harness than it pins), plus the sync-send property `sendUpdate` must
 * keep on the no-`revalidate` path.
 */
describe("conditional revalidation — a push etag rides only the update frame", () => {
  test("invalidate-mode notify never invokes revalidate", async () => {
    // The regression fence for the `edited-files` waste. An invalidate push carries
    // no value, so it carries no etag — and must therefore never run the signature.
    // The read path (the sub-ack below) legitimately runs it to stamp the ack; the
    // push must not.
    const h = createHarness();
    let revalidations = 0;
    const r = h.runtime.defineExternalResource({
      key: "r",
      mode: "invalidate",
      schema: z.string(),
      loader: async () => "val",
      revalidate: async () => {
        revalidations++;
        return "sig-1";
      },
    });

    await h.subscribe("r"); // read path: stamps the sub-ack etag → one revalidate
    const before = revalidations;
    expect(before).toBeGreaterThan(0); // the read path did run it (baseline)

    r.notify();
    await tick();

    // The push ran no signature at all — the whole point.
    expect(revalidations).toBe(before);
    const pushes = h.pushesFor("r");
    expect(pushes).toHaveLength(1);
    const push = pushes[0]!;
    expect(push.kind).toBe("invalidate");
    expect("etag" in push).toBe(false); // no value ⇒ no etag, structurally
  });

  test("push-mode update still carries a co-produced etag on notify", async () => {
    // The byte-identical path: a `push`-mode resource (jsonl-events, commits-graph)
    // ships a value-carrying `update` on notify, so its etag IS computed — by
    // `sendUpdate`, over the same drain that read the value. Advance both the value
    // and the signature so the pushed frame must pair the fresh value with the fresh
    // etag. Guards a future `sendUpdate` refactor silently dropping it.
    const h = createHarness();
    let gitState = 1;
    const ctl = controllable("v1");
    const r = h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: ctl.loader,
      revalidate: async () => String(gitState),
    });

    await h.subscribe("r"); // sub-ack: value "v1", etag sig("1")
    ctl.setValue("v2");
    gitState = 2; // the change: value and signature advance together
    r.notify();
    await tick();

    const update = h.pushesFor("r").find((f) => f.kind === "update")!;
    expect(update.value).toBe("v2");
    expect(update.etag).toBe(sig("2")); // co-produced over the same push
  });

  test("a throwing revalidate is not reported on the push path", async () => {
    // Corollary of the invariant: since the invalidate push never runs the
    // signature, a broken one is never reported from here — the report would be
    // about work whose result the push discards. The read path (the sub-ack) still
    // reports it, where the etag is actually consumed.
    const reportError = mock((_context: string, _err: unknown) => {});
    const h = createHarness({ reportError });
    const r = h.runtime.defineExternalResource({
      key: "r",
      mode: "invalidate",
      schema: z.string(),
      loader: async () => "val",
      revalidate: async () => {
        throw new Error("signature boom");
      },
    });

    await h.subscribe("r"); // read path: computeEtag catches → reportError fires
    expect(reportError).toHaveBeenCalled();
    reportError.mockClear();

    r.notify();
    await tick();

    expect(reportError).not.toHaveBeenCalled(); // the push never touched the signature
  });

  test("no-revalidate update sends synchronously — the push beats a racing parked sub-ack", async () => {
    // Guards `sendUpdate`'s SYNC-SEND property: a `push`-mode resource WITHOUT
    // `revalidate` (almost every resource) must build AND broadcast its frame with
    // no microtask before the `ws.send`, so a push still wins the race against a
    // fresh sub whose loader is parked. `runtime-h5.test.ts` H5a pins the same
    // ordering through the notify-vs-fresh-sub invariant; this is a deliberate
    // co-guard in the file that owns the etag/push-path invariant (H5a is off-limits
    // to annotate), and it additionally asserts the frame carries NO etag — tying
    // the ordering specifically to `sendUpdate`'s no-await branch. If `sendUpdate`
    // regresses to a returned-and-awaited frame, both this and H5a fail.
    const h = createHarness();
    const ctl = controllable("A");
    const r = h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.string(),
      loader: ctl.loader,
      // no `revalidate` — the sync-send branch
    });

    ctl.block();
    ctl.setValue("B");
    await h.subscribe("r"); // sub-ack parked on the blocked loader
    expect(h.frames).toHaveLength(0);

    // Bumps the version past the parked sub-ack's and starts its own load: since
    // the flight-freshness fix the drain refuses the sub's older flight rather
    // than coalescing onto it
    // (`research/2026-08-08-global-live-state-flight-freshness.md`). Both loads
    // park on the same block, so the race being timed is unchanged — what this
    // case measures is `sendUpdate`'s no-await branch, not the sharing.
    r.notify();
    await tick();
    expect(h.frames).toHaveLength(0);

    ctl.release();
    await tick();

    const update = h.frames.find((f) => f.kind === "update")!;
    const subAck = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(update.seq).toBeLessThan(subAck.seq); // the push hits the wire first
    expect("etag" in update).toBe(false); // no revalidate ⇒ no etag on the frame
  });
});

/**
 * D8 — a recompute that changed nothing sends nothing. A non-keyed drain of a
 * pushed `revalidate` resource with subscribers loads before it mints; when the
 * loader hands back the very object (`===`) every holder holds — a signed
 * memo's hit — it sends no frame, bumps no version, and only acks. Equal
 * content in a new object is a change (nothing is hashed). The held object is
 * set by the frame that carried it and by the sub-ack that opened the tuple's
 * span to its sole holder; a read handing anyone anything else, a failed load
 * and N→0 drop it.
 */
describe("D8 — a recompute returning the object last sent sends nothing", () => {
  function memoized(mode: "push" | "invalidate" = "push") {
    let current = { s: "s1" };
    let loads = 0;
    let refuse = false;
    let gate: Promise<void> = Promise.resolve();
    const h = createHarness({ sockets: 2 });
    const r = h.runtime.defineExternalResource(
      {
        key: "r",
        schema: z.object({ s: z.string() }),
        validateParams: () => {},
        refusals: ["gone"],
      },
      {
        mode,
        // A signed memo: the cached object until the state moves.
        loader: async () => {
          loads++;
          await gate;
          if (refuse) throw new ResourceRefusal("gone", "it went away");
          return current;
        },
        revalidate: async () => current.s,
      },
    );
    return {
      h,
      r,
      loads: () => loads,
      /** A new object (the memo recomputed), with content `s`. */
      replace: (s: string) => {
        current = { s };
      },
      current: () => current,
      /** Hand back an earlier object again (a memo holding it still). */
      restore: (obj: { s: string }) => {
        current = obj;
      },
      refuse: (on: boolean) => {
        refuse = on;
      },
      /** Park every load until the returned release is called. */
      park: () => {
        let release!: () => void;
        gate = new Promise((res) => (release = res));
        return () => {
          gate = Promise.resolve();
          release();
        };
      },
    };
  }
  const subAckVersion = (h: { frames: RecordedFrame[] }): number =>
    h.frames.find((f) => f.kind === "sub-ack")!.version!;

  test("the same object as the sub-ack's: no frame and no version bump", async () => {
    const t = memoized();
    await t.h.subscribe("r"); // the sole holder: it holds the memo's object
    const v0 = subAckVersion(t.h);
    t.r.notify();
    await tick();
    t.r.notify();
    await tick();
    expect(t.h.pushesFor("r")).toEqual([]);
    // No version was minted for the skipped drains: the next real change is v0 + 1.
    t.replace("s2");
    t.r.notify();
    await tick();
    expect(t.h.pushesFor("r").map((f) => [f.kind, f.version, f.value])).toEqual(
      [["update", v0 + 1, { s: "s2" }]],
    );
  });

  test("the same object as the last frame's: no frame", async () => {
    const t = memoized();
    await t.h.subscribe("r", {}, { socket: 0 });
    await t.h.subscribe("r", {}, { socket: 1 });
    t.replace("s2");
    t.r.notify(); // a new object: the frame carries it to both holders
    await tick();
    t.r.notify(); // the same object again
    await tick();
    expect(t.h.pushesFor("r", 1).map((f) => [f.kind, f.value])).toEqual([
      ["update", { s: "s2" }],
    ]);
  });

  test("a skipped recompute still acks the write it was routed for", async () => {
    const value = { s: "same" };
    let loads = 0;
    const h = createHarness();
    h.runtime.defineExternalResource(
      {
        key: "r",
        schema: z.object({ s: z.string() }),
        validateParams: () => {},
      },
      {
        mode: "push",
        reach: mintReachPlan({
          routes: [
            {
              id: "c",
              table: "conversations",
              map: { kind: "full", reason: "whole" },
              columns: ["id"],
            },
          ],
          usesOf: () => new Map([["c", { role: "membership" as const }]]),
        }),
        loader: () => {
          loads++;
          return value;
        },
        revalidate: async () => "same",
      },
    );
    await h.subscribe("r", {}, { acks: true });
    const write = (xid: string) =>
      h.runtime.routeTableChange({
        source: "feed",
        table: "conversations",
        op: "U",
        ids: ["x"],
        keys: null,
        unchanged: null,
        xid,
      });
    const before = loads;
    write("tx-1");
    await tick();
    write("tx-2");
    await tick();
    expect(loads).toBe(before + 2); // the recompute runs: only the frame is skipped
    expect(h.pushesFor("r").map((f) => [f.kind, f.ackTx])).toEqual([
      ["ack", ["tx-1"]],
      ["ack", ["tx-2"]],
    ]);
  });

  test("a new object with equal content is a change: the frame goes out", async () => {
    const t = memoized();
    await t.h.subscribe("r");
    t.replace("s1");
    t.r.notify();
    await tick();
    expect(t.h.pushesFor("r").map((f) => [f.kind, f.value])).toEqual([
      ["update", { s: "s1" }],
    ]);
  });

  test("a changed value delivers, and is then the held object", async () => {
    const t = memoized();
    await t.h.subscribe("r");
    t.replace("s2");
    t.r.notify();
    await tick();
    t.r.notify();
    await tick();
    expect(t.h.pushesFor("r").map((f) => [f.kind, f.value])).toEqual([
      ["update", { s: "s2" }],
    ]);
  });

  test("a refused load drops the held object: the holder on the refusal gets the value back", async () => {
    const t = memoized();
    await t.h.subscribe("r");
    t.refuse(true);
    t.r.notify();
    await tick();
    t.refuse(false);
    t.r.notify(); // the very object the sub-ack carried — but the holder sits on the refusal
    await tick();
    expect(t.h.pushesFor("r").map((f) => [f.kind, f.value])).toEqual([
      ["sub-error", undefined],
      ["update", { s: "s1" }],
    ]);
  });

  test("a second holder's sub-ack under another object drops the held one", async () => {
    const t = memoized();
    const s1 = t.current();
    await t.h.subscribe("r", {}, { socket: 0 }); // sole: holds s1
    t.replace("s2");
    await t.h.subscribe("r", {}, { socket: 1 }); // reads s2
    // The loader hands back s1 again: socket 0 holds it, socket 1 does not.
    t.restore(s1);
    t.r.notify();
    await tick();
    expect(t.h.pushesFor("r", 1).map((f) => [f.kind, f.value])).toEqual([
      ["update", { s: "s1" }],
    ]);
  });

  test("the last unsubscribe drops the held object", async () => {
    const t = memoized();
    await t.h.subscribe("r"); // sole: holds the object
    await t.h.unsub("r");
    // Two subscribers land together, so neither sub-ack is a sole holder's: a
    // held object surviving N→0 would skip the notify below.
    const release = t.park();
    const a = t.h.subscribe("r", {}, { socket: 0 });
    const b = t.h.subscribe("r", {}, { socket: 1 });
    await a;
    await b;
    release();
    await tick();
    t.r.notify();
    await tick();
    expect(t.h.pushesFor("r", 0).map((f) => f.kind)).toEqual(["update"]);
  });

  test("invalidate mode is unaffected: every recompute sends its invalidate", async () => {
    const t = memoized("invalidate");
    await t.h.subscribe("r");
    t.r.notify();
    await tick();
    t.r.notify();
    await tick();
    expect(t.h.pushesFor("r").map((f) => f.kind)).toEqual([
      "invalidate",
      "invalidate",
    ]);
  });
});
