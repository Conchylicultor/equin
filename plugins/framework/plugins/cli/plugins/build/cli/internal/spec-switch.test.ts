import { describe, expect, test } from "bun:test";
import type { AdoptVerdict } from "@plugins/build/plugins/restart-skip/core";
import type { DistPublication } from "./dist-publish";
import { settleFailedServe, switchSpec } from "./spec-switch";

interface Spec {
  name: string;
  server: string;
}

const SLOT_A = "/slots/slot-1/plugins/framework/plugins/server-core";
const SLOT_B = "/slots/slot-2/plugins/framework/plugins/server-core";
const specIn = (server: string): Spec => ({ name: "main", server });

/** The namespace's spec file and every step taken around it, in order. */
function world(
  previous: Spec | null,
  verdict: AdoptVerdict = { kind: "restart", reason: "code differs" },
) {
  const events: string[] = [];
  const state = { spec: previous };
  return {
    events,
    state,
    deps: {
      previous,
      restart: true,
      sameCheckout: async (a: string, b: string) => a === b,
      ask: async () => {
        events.push("ask");
        return verdict;
      },
      handOver: async () => {
        events.push("handOver");
      },
      write: async (spec: Spec) => {
        events.push(`write ${spec.server}`);
        state.spec = spec;
      },
    },
  };
}

function publication(revertible = true) {
  const events: string[] = [];
  const p: DistPublication = {
    revertible,
    keep: async () => {
      events.push("keep");
    },
    revert: async () => {
      events.push("revert");
    },
  };
  return { p, events };
}

describe("a deploy from another slot that fails with the previous backend serving (2c)", () => {
  test("the previous spec is put back, after the frontend", async () => {
    // Main serves from slot A; this build ran in slot B.
    const w = world(specIn(SLOT_A));
    const switched = await switchSpec({ ...w.deps, spec: specIn(SLOT_B) });
    expect(switched.kind).toBe("written");
    if (switched.kind !== "written") return;
    // Asked before the spec moved, then handed over, then switched.
    expect(w.events).toEqual(["ask", "handOver", `write ${SLOT_B}`]);
    expect(w.state.spec?.server).toBe(SLOT_B);

    // The restart failed and the previous backend is the one left serving.
    const pub = publication();
    const reason = await settleFailedServe({
      backend: "previous",
      publication: pub.p,
      restore: switched.restore,
      site: "http://equin.localhost:9000",
    });
    expect(pub.events).toEqual(["revert"]);
    // The spec names the slot that serves again: a respawn boots slot A.
    expect(w.state.spec?.server).toBe(SLOT_A);
    expect(reason[0]).toContain("spec names the checkout it serves from again");
    expect(reason[1]).toContain("rolled back");
  });

  test("a failure that left the NEW backend serving keeps the new spec and frontend", async () => {
    const w = world(specIn(SLOT_A));
    const switched = await switchSpec({ ...w.deps, spec: specIn(SLOT_B) });
    if (switched.kind !== "written") throw new Error("expected written");
    const pub = publication();
    await settleFailedServe({
      backend: "this-tree",
      publication: pub.p,
      restore: switched.restore,
      site: "s",
    });
    expect(pub.events).toEqual(["keep"]);
    expect(w.state.spec?.server).toBe(SLOT_B);
  });

  test("a deploy into the checkout the spec already names has nothing to put back", async () => {
    const w = world(specIn(SLOT_B));
    const switched = await switchSpec({ ...w.deps, spec: specIn(SLOT_B) });
    if (switched.kind !== "written") throw new Error("expected written");
    // Not a switch: not asked here (the deploy asks after the spec write).
    expect(w.events).toEqual(["handOver", `write ${SLOT_B}`]);
    expect(switched.askedFirst).toBeNull();
    expect(switched.restore).toBeNull();
    const pub = publication(false);
    const reason = await settleFailedServe({
      backend: "previous",
      publication: pub.p,
      restore: switched.restore,
      site: "s",
    });
    expect(pub.events).toEqual(["revert"]);
    expect(w.state.spec?.server).toBe(SLOT_B);
    expect(reason).toEqual([
      "There was no previous frontend to roll back to, so the new one stays published.",
    ]);
  });

  test("a first deploy (no spec yet) writes it and has nothing to put back", async () => {
    const w = world(null);
    const switched = await switchSpec({ ...w.deps, spec: specIn(SLOT_B) });
    if (switched.kind !== "written") throw new Error("expected written");
    expect(w.events).toEqual(["handOver", `write ${SLOT_B}`]);
    expect(switched.restore).toBeNull();
  });
});

describe("switchSpec: a switch the running backend adopts", () => {
  test("keeps the spec on the checkout it runs from, and hands nothing over", async () => {
    const w = world(specIn(SLOT_A), { kind: "adopted" });
    const switched = await switchSpec({ ...w.deps, spec: specIn(SLOT_B) });
    expect(switched).toEqual({ kind: "kept", servedFrom: SLOT_A });
    expect(w.events).toEqual(["ask"]);
    expect(w.state.spec?.server).toBe(SLOT_A);
  });

  test("--no-restart asks nothing, but still switches and can put it back", async () => {
    const w = world(specIn(SLOT_A));
    const switched = await switchSpec({
      ...w.deps,
      restart: false,
      spec: specIn(SLOT_B),
    });
    if (switched.kind !== "written") throw new Error("expected written");
    expect(w.events).toEqual(["handOver", `write ${SLOT_B}`]);
    expect(switched.askedFirst).toBeNull();
    await switched.restore?.();
    expect(w.state.spec?.server).toBe(SLOT_A);
  });

  test("a verdict other than adopted is handed back for the restart step", async () => {
    const w = world(specIn(SLOT_A), { kind: "cannot-judge", reason: "x" });
    const switched = await switchSpec({ ...w.deps, spec: specIn(SLOT_B) });
    if (switched.kind !== "written") throw new Error("expected written");
    expect(switched.askedFirst).toEqual({ kind: "cannot-judge", reason: "x" });
  });
});
