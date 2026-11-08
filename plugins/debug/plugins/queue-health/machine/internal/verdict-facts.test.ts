import { describe, expect, test } from "bun:test";
import type { QueueActivity } from "@plugins/infra/plugins/jobs/machine";
import { createVerdictFacts } from "./verdict-facts";

// The verdict's held reads: re-queried only once activity says they may have
// moved, never held while nobody tracks the changes, and never held when a
// change landed while the query ran.

function harness() {
  const calls = { classes: 0, dead: 0 };
  const listeners = new Set<(a: QueueActivity) => void>();
  const pending: (() => void)[] = [];
  let gated = false;
  const answer = <T>(value: () => T) =>
    gated
      ? new Promise<T>((resolve) => pending.push(() => resolve(value())))
      : Promise.resolve(value());
  const facts = createVerdictFacts({
    classes: () => answer(() => ++calls.classes),
    dead: () => answer(() => ++calls.dead),
    onActivity: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  });
  return {
    facts,
    calls,
    listeners,
    emit: (a: QueueActivity) => {
      for (const l of listeners) l(a);
    },
    gate: () => {
      gated = true;
    },
    releaseAll: () => {
      gated = false;
      for (const p of pending.splice(0)) p();
    },
  };
}

describe("verdict facts", () => {
  test("untracked, every read queries", async () => {
    const h = harness();
    await h.facts.classes.read();
    await h.facts.classes.read();
    expect(h.calls.classes).toBe(2);
  });

  test("tracked, a read is re-run only by activity that may have moved it", async () => {
    const h = harness();
    const release = h.facts.track();
    expect(await h.facts.classes.read()).toBe(1);
    expect(await h.facts.dead.read()).toBe(1);

    h.emit({ unheldRows: false, deaths: false, ready: false }); // a plain success
    expect(await h.facts.classes.read()).toBe(1);
    expect(await h.facts.dead.read()).toBe(1);

    h.emit({ unheldRows: true, deaths: false, ready: false }); // a pickup
    expect(await h.facts.classes.read()).toBe(2);
    expect(await h.facts.dead.read()).toBe(1);

    h.emit({ unheldRows: true, deaths: true, ready: true }); // a failure
    expect(await h.facts.classes.read()).toBe(3);
    expect(await h.facts.dead.read()).toBe(2);

    h.facts.invalidateAll(); // the change timer fired
    expect(await h.facts.classes.read()).toBe(4);
    expect(await h.facts.dead.read()).toBe(3);
    release();
  });

  test("a refresh is held for the next read", async () => {
    const h = harness();
    const release = h.facts.track();
    await h.facts.classes.refresh();
    expect(await h.facts.classes.read()).toBe(1);
    release();
  });

  test("an answer to a query a change overtook is not held", async () => {
    const h = harness();
    const release = h.facts.track();
    h.gate();
    const inFlight = h.facts.classes.read();
    h.emit({ unheldRows: true, deaths: false, ready: false });
    h.releaseAll();
    expect(await inFlight).toBe(1);
    expect(await h.facts.classes.read()).toBe(2);
    release();
  });

  test("a query started before tracking is not held", async () => {
    const h = harness();
    h.gate();
    const inFlight = h.facts.classes.read();
    const release = h.facts.track();
    h.releaseAll();
    await inFlight;
    expect(await h.facts.classes.read()).toBe(2);
    release();
  });

  test("the last release stops listening and forgets what it held", async () => {
    const h = harness();
    const a = h.facts.track();
    const b = h.facts.track();
    expect(h.listeners.size).toBe(1);
    await h.facts.classes.read();
    a();
    a(); // idempotent
    expect(h.listeners.size).toBe(1);
    expect(await h.facts.classes.read()).toBe(1);
    b();
    expect(h.listeners.size).toBe(0);
    expect(await h.facts.classes.read()).toBe(2);
  });
});
