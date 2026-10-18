import { describe, expect, test } from "bun:test";

import { createSignedMemo } from "./signed-memo";

// bun:test types `expect(...).rejects` as non-thenable, so `await`ing it trips
// @typescript-eslint/await-thenable. Settle the promise explicitly and return the
// rejection, which also lets a resolution fail loudly instead of passing silently.
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    (value) => ({ value }),
    (err: unknown) => ({ err }),
  );
  if (!("err" in outcome)) {
    throw new Error(
      `expected a rejection, but it resolved to ${String(outcome.value)}`,
    );
  }
  expect(outcome.err).toBeInstanceOf(Error);
  return outcome.err as Error;
}

/**
 * A fake authority: an in-memory "state" the signature fingerprints and the
 * compute reads. No git, no filesystem — the memo's contract is about the
 * relationship between the two functions, not about what they read.
 */
function createFakeAuthority() {
  const state = {
    sig: "S1",
    /** Value the next compute will return; advanced alongside `sig` by default. */
    value: "V1",
    signatureCalls: 0,
    computeCalls: 0,
    /** Set to park compute until the returned resolver fires. */
    gate: null as null | { promise: Promise<void>; release: () => void },
    signatureThrows: false,
    computeThrows: false,
  };
  const memo = createSignedMemo<string>({
    name: "test",
    signature: async () => {
      state.signatureCalls++;
      if (state.signatureThrows) throw new Error("signature failed");
      return state.sig;
    },
    compute: async () => {
      state.computeCalls++;
      // Read the authority when the compute starts, as a real read does: a
      // change landing while it is parked is not in its result.
      const value = state.value;
      if (state.gate) await state.gate.promise;
      if (state.computeThrows) throw new Error("compute failed");
      return value;
    },
  });
  return { state, memo };
}

function openGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("createSignedMemo", () => {
  test("revalidate and loader share one authority", async () => {
    const { state, memo } = createFakeAuthority();

    // The signature a `revalidate` would ship is the same probe `get` reads
    // through: there is one declaration site, so passing a disagreeing pair is
    // not expressible.
    expect(await memo.signature("k")).toBe("S1");
    expect(await memo.get("k")).toBe("V1");
    expect(state.computeCalls).toBe(1);

    // Move the authority: both the signature and the value advance together.
    state.sig = "S2";
    state.value = "V2";
    expect(await memo.signature("k")).toBe("S2");
    // The loader is exactly as fresh as the ETag — it re-probes and misses.
    expect(await memo.get("k")).toBe("V2");
    expect(state.computeCalls).toBe(2);
    // And caches under the signature `memo.signature` now returns.
    expect(await memo.get("k")).toBe("V2");
    expect(state.computeCalls).toBe(2);
  });

  test("prime with a pre-compute signature: a mid-compute change forces a re-probe, never a torn hit", async () => {
    const { state, memo } = createFakeAuthority();

    // An authoritative external writer captures the signature (S1) BEFORE
    // computing. A change lands mid-compute, so the value it produced (V2) is
    // labelled with the older S1.
    memo.prime("k", "S1", "V2");

    // The world is now at S2 (the change that landed mid-compute).
    state.sig = "S2";
    state.value = "V3";

    // `get` probes S2, finds the entry stamped S1, and misses. It never returns
    // V2 as an S2 hit — the stored signature being older only over-invalidates.
    expect(await memo.get("k")).toBe("V3");
    expect(state.computeCalls).toBe(1);
  });

  test("a hit runs no compute", async () => {
    const { state, memo } = createFakeAuthority();

    expect(await memo.get("k")).toBe("V1");
    expect(state.computeCalls).toBe(1);

    // Signature unchanged ⇒ pure cache hits, no compute (and so no heavy slot).
    expect(await memo.get("k")).toBe("V1");
    expect(await memo.get("k")).toBe("V1");
    expect(state.computeCalls).toBe(1);
    // The cheap probe, by contrast, runs on every read (and once more after
    // the compute, confirming the signature it caches under).
    expect(state.signatureCalls).toBe(4);
  });

  test("a primed entry is a hit under a matching signature", async () => {
    const { state, memo } = createFakeAuthority();

    memo.prime("k", "S1", "primed");
    expect(await memo.get("k")).toBe("primed");
    expect(state.computeCalls).toBe(0);
  });

  test("concurrent misses single-flight onto one compute", async () => {
    const { state, memo } = createFakeAuthority();
    state.gate = openGate();

    const a = memo.get("k");
    const b = memo.get("k");
    state.gate.release();

    expect(await a).toBe("V1");
    expect(await b).toBe("V1");
    expect(state.computeCalls).toBe(1);
  });

  test("notBefore supersedes a compute started before it instead of joining it", async () => {
    const { state, memo } = createFakeAuthority();
    const first = openGate();
    state.gate = first;

    // A compute starts and parks mid-flight on the pre-change state.
    const stale = memo.get("k");
    await Bun.sleep(0);
    expect(state.computeCalls).toBe(1);

    // An input moves that the caller knows the instant of (the signature
    // itself has not caught up yet — the case only the floor can see).
    const changedAt = performance.now();
    state.value = "V2";
    state.gate = null;

    // Without the floor this would join the parked flight and get V1.
    const fresh = memo.get("k", { notBefore: changedAt });
    expect(await fresh).toBe("V2");
    expect(state.computeCalls).toBe(2);

    // The superseded compute settles under the signature the fresh one
    // already cached: its callers get that held answer (at least as new).
    first.release();
    expect(await stale).toBe("V2");
  });

  test("a mid-flight miss at ANOTHER signature never joins the running compute", async () => {
    // The joiner probed S2; joining the compute that started at S1 would hand
    // it V1, which its caller stamps S2 (a resource's ETag, D8's held
    // signature) — a stale value under a current signature, which every later
    // probe of S2 answers "unchanged".
    const { state, memo } = createFakeAuthority();
    const gate = openGate();
    state.gate = gate;

    const a = memo.get("k");
    await Bun.sleep(0);
    expect(state.computeCalls).toBe(1);
    state.sig = "S2";
    state.value = "V2";
    state.gate = null;
    const b = memo.get("k");
    gate.release();

    expect(await a).toBe("V1");
    expect(await b).toBe("V2");
    expect(state.computeCalls).toBe(2);
    // The S1 compute settled at S2: not cached under S1 — S2's entry stands.
    expect(await memo.get("k")).toBe("V2");
    expect(state.computeCalls).toBe(2);
  });

  test("a compute that read a state its signature then left is not cached — an undone edit is never a hit", async () => {
    const { state, memo } = createFakeAuthority();
    // Probed at S1; by the time the compute reads, an edit (B) has landed.
    state.gate = openGate();
    const gate = state.gate;
    state.value = "VB";
    const read = memo.get("k");
    await Bun.sleep(0);
    state.sig = "SB"; // the edit, as the signature sees it
    state.gate = null;
    gate.release();
    expect(await read).toBe("VB");

    // The edit is undone: the signature is S1 again. A cached {S1, VB} would
    // be a hit serving the reverted-away value for good.
    state.sig = "S1";
    state.value = "V1";
    expect(await memo.get("k")).toBe("V1");
    expect(state.computeCalls).toBe(2);
  });

  test("concurrent misses on distinct keys each compute", async () => {
    const { state, memo } = createFakeAuthority();

    expect(await Promise.all([memo.get("k1"), memo.get("k2")])).toEqual([
      "V1",
      "V1",
    ]);
    expect(state.computeCalls).toBe(2);
  });

  test("evict drops the entry; the next get recomputes", async () => {
    const { state, memo } = createFakeAuthority();

    expect(await memo.get("k")).toBe("V1");
    expect(state.computeCalls).toBe(1);

    memo.evict("k");

    // Same signature, but no entry to hit.
    expect(await memo.get("k")).toBe("V1");
    expect(state.computeCalls).toBe(2);
  });

  test("a throwing signature propagates and caches nothing", async () => {
    const { state, memo } = createFakeAuthority();

    state.signatureThrows = true;
    expect((await rejectionOf(memo.get("k"))).message).toContain(
      "signature failed",
    );
    expect((await rejectionOf(memo.signature("k"))).message).toContain(
      "signature failed",
    );
    // The failure short-circuits before any compute — no fallback value.
    expect(state.computeCalls).toBe(0);

    state.signatureThrows = false;
    expect(await memo.get("k")).toBe("V1");
    expect(state.computeCalls).toBe(1);
  });

  test("a throwing compute propagates and caches nothing", async () => {
    const { state, memo } = createFakeAuthority();

    state.computeThrows = true;
    expect((await rejectionOf(memo.get("k"))).message).toContain(
      "compute failed",
    );
    expect(state.computeCalls).toBe(1);

    // No poisoned entry: the next get recomputes rather than serving a value
    // (or a rejection) cached under the current signature.
    state.computeThrows = false;
    expect(await memo.get("k")).toBe("V1");
    expect(state.computeCalls).toBe(2);
  });

  test("an answer under an unchanged signature keeps the cached object's identity", async () => {
    let sig = "S1";
    let computed = 0;
    const memo = createSignedMemo<{ v: string }>({
      name: "identity",
      signature: async () => sig,
      compute: async () => ({ v: `c${++computed}` }),
    });
    const first = await memo.get("k");
    // A prime under the held signature (a watcher's first read) keeps it.
    memo.prime("k", "S1", { v: "primed" });
    expect(await memo.get("k")).toBe(first);
    // A moved signature replaces it.
    sig = "S2";
    const second = await memo.get("k");
    expect(second).not.toBe(first);
    memo.prime("k", "S2", { v: "primed" });
    expect(await memo.get("k")).toBe(second);
  });
});
