import { describe, expect, test } from "bun:test";

import { createSignedMemo } from "./signed-memo";

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
    expect(memo.get("k")).rejects.toThrow("signature failed");
    expect(memo.signature("k")).rejects.toThrow("signature failed");
    // The failure short-circuits before any compute — no fallback value.
    expect(state.computeCalls).toBe(0);

    state.signatureThrows = false;
    expect(await memo.get("k")).toBe("V1");
    expect(state.computeCalls).toBe(1);
  });

  test("a throwing compute propagates and caches nothing", async () => {
    const { state, memo } = createFakeAuthority();

    state.computeThrows = true;
    expect(memo.get("k")).rejects.toThrow("compute failed");
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

  describe("a memo over caller-held input", () => {
    // The input a live value's followed rows hand it: the memo reads nothing
    // itself, and the signature fingerprints the input.
    function createInputMemo() {
      const seen = { signature: [] as string[], compute: [] as string[] };
      const memo = createSignedMemo<string, { ids: readonly string[] }>({
        name: "input",
        signature: async (key, input) => {
          seen.signature.push(`${key}:${input.ids.join(",")}`);
          return `${key}|${input.ids.join(",")}`;
        },
        compute: async (key, input) => {
          seen.compute.push(`${key}:${input.ids.join(",")}`);
          return `${key}=${input.ids.length}`;
        },
      });
      return { seen, memo };
    }

    test("the probe and the compute are handed the same input", async () => {
      const { seen, memo } = createInputMemo();
      expect(await memo.signature("k", { input: { ids: ["a"] } })).toBe("k|a");
      expect(await memo.get("k", { input: { ids: ["a", "b"] } })).toBe("k=2");
      // `get` re-probes after its compute (an undone change is never a hit),
      // with the same input.
      expect(seen.signature).toEqual(["k:a", "k:a,b", "k:a,b"]);
      expect(seen.compute).toEqual(["k:a,b"]);
    });

    test("an unchanged input is a hit; a moved input recomputes", async () => {
      const { seen, memo } = createInputMemo();
      const first = await memo.get("k", { input: { ids: ["a"] } });
      expect(await memo.get("k", { input: { ids: ["a"] } })).toBe(first);
      expect(seen.compute).toEqual(["k:a"]);
      expect(await memo.get("k", { input: { ids: ["a", "b"] } })).toBe("k=2");
      expect(seen.compute).toEqual(["k:a", "k:a,b"]);
    });

    test("notBefore rides beside the input", async () => {
      const gate = openGate();
      let started = 0;
      const parked = createSignedMemo<string, string>({
        name: "input-not-before",
        signature: async (_key, input) => input,
        compute: async (_key, input) => {
          started++;
          await gate.promise;
          return input;
        },
      });
      const first = parked.get("k", { input: "S" });
      await Bun.sleep(0);
      expect(started).toBe(1);
      // Joins the running compute: same signature, no floor.
      const joined = parked.get("k", { input: "S" });
      // Refuses it: the floor is after its start.
      const fresh = parked.get("k", {
        input: "S",
        notBefore: performance.now(),
      });
      await Bun.sleep(0);
      gate.release();
      expect(await Promise.all([first, joined, fresh])).toEqual([
        "S",
        "S",
        "S",
      ]);
      expect(started).toBe(2);
    });

    test("a memo without input takes none (tsc)", async () => {
      const { memo } = createFakeAuthority();
      // @ts-expect-error — a void-input memo is handed no input
      await memo.signature("k", { input: 1 });
      const { memo: withInput } = createInputMemo();
      // @ts-expect-error — an input memo's probe requires its input
      const pending = withInput.signature("k");
      expect(pending).rejects.toBeInstanceOf(Error);
    });
  });
});

/**
 * A memo whose signature probe is slow and counted — the transcript chain's
 * glob + lstat — parked on demand so a test can line callers up against one
 * running probe.
 */
function createProbedAuthority(shared: boolean) {
  const state = {
    sig: "S1",
    value: "V1",
    probes: 0,
    computes: 0,
    probeGate: null as null | ReturnType<typeof openGate>,
    computeGate: null as null | ReturnType<typeof openGate>,
  };
  const memo = createSignedMemo<string>({
    name: "probed",
    signature: async () => {
      state.probes++;
      // Read when the probe starts, like an lstat: a change landing while it
      // is parked is not in its answer.
      const sig = state.sig;
      if (state.probeGate) await state.probeGate.promise;
      return sig;
    },
    compute: async () => {
      state.computes++;
      // Read when released: the compute sees whatever landed while parked.
      if (state.computeGate) await state.computeGate.promise;
      return state.value;
    },
    ...(shared ? { shareProbes: { inputKey: () => "" } } : {}),
  });
  return { state, memo };
}

/** N values resubscribing at once: each revalidates, then loads. */
async function resubscribe(
  memo: ReturnType<typeof createProbedAuthority>["memo"],
  n: number,
): Promise<string[]> {
  return Promise.all(
    Array.from({ length: n }, async () => {
      await memo.signature("conv");
      return memo.get("conv");
    }),
  );
}

describe("createSignedMemo — shareProbes", () => {
  test("a resubscribe of N values probes once per phase, not twice per value", async () => {
    // Warm both: the entry is cached, as for a conversation already read.
    const unshared = createProbedAuthority(false);
    const shared = createProbedAuthority(true);
    await unshared.memo.get("conv");
    await shared.memo.get("conv");
    unshared.state.probes = 0;
    shared.state.probes = 0;

    expect(await resubscribe(unshared.memo, 8)).toEqual(Array(8).fill("V1"));
    expect(await resubscribe(shared.memo, 8)).toEqual(Array(8).fill("V1"));
    // Before: every revalidate and every get probes on its own.
    expect(unshared.state.probes).toBe(16);
    // After: the 8 revalidates share one probe, the 8 gets another.
    expect(shared.state.probes).toBe(2);
    expect(shared.state.computes).toBe(1);
  });

  test("a probe started before a prime is not joined", async () => {
    const { state, memo } = createProbedAuthority(true);
    state.probeGate = openGate();
    const early = memo.signature("conv"); // reads S1, parked
    // The source changes and the watch primes before telling anyone.
    state.sig = "S2";
    memo.prime("conv", "S2", "V2");
    // The read the change's notify triggers must see S2, not join `early`.
    const late = memo.signature("conv");
    state.probeGate.release();
    expect(await early).toBe("S1");
    expect(await late).toBe("S2");
    expect(state.probes).toBe(2);
  });

  test("callers with no prime between them join one probe", async () => {
    const { state, memo } = createProbedAuthority(true);
    state.probeGate = openGate();
    const a = memo.signature("conv");
    const b = memo.signature("conv");
    state.probeGate.release();
    expect([await a, await b]).toEqual(["S1", "S1"]);
    expect(state.probes).toBe(1);
  });

  test("the post-compute re-probe never joins a probe that started before the compute ended", async () => {
    const { state, memo } = createProbedAuthority(true);
    // A get probes S1 (a miss: nothing cached) and its compute parks.
    state.computeGate = openGate();
    const loaded = memo.get("conv");
    while (state.computes === 0) await Promise.resolve();
    expect(state.probes).toBe(1);
    // A revalidate's probe reads S1 and stalls (a host file stall).
    const stall = openGate();
    state.probeGate = stall;
    const stalled = memo.signature("conv");
    state.probeGate = null;
    // The source changes; the compute reads the changed value.
    state.sig = "S2";
    state.value = "V2";
    state.computeGate.release();
    state.computeGate = null;
    // Let the compute finish and its re-probe start.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // The change is undone, and the stalled probe settles.
    state.sig = "S1";
    state.value = "V1";
    stall.release();
    expect(await loaded).toBe("V2");
    expect(await stalled).toBe("S1");
    // Had the re-probe joined the stalled flight (S1), {S1, V2} would be cached
    // and — the state back at S1 — served for good. It probed fresh (S2), so
    // nothing was cached and this read recomputes.
    expect(await memo.get("conv")).toBe("V1");
  });
});
