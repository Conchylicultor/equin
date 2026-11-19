import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, test } from "bun:test";
import { memoLifetime, type MemoHolder } from "./memo-holds";

/** A lifetime with ALS-tracked holders, as the check runner installs one. */
function tracked() {
  const lifetime = memoLifetime();
  const current = new AsyncLocalStorage<MemoHolder>();
  lifetime.installMemoHolds({
    current: () => current.getStore(),
    run: (holder, fn) => current.run(holder, fn),
  });
  const unit = () => {
    const held = new Set<object>();
    const holder: MemoHolder = { hold: (e) => void held.add(e) };
    return {
      held,
      run: <T>(fn: () => T): T => current.run(holder, fn),
      release: () => held.clear(),
    };
  };
  return { lifetime, unit };
}

/** Collect until `done` holds (a conservative stack scan can keep one round). */
async function collectUntil(done: () => boolean): Promise<boolean> {
  for (let i = 0; i < 20 && !done(); i++) {
    Bun.gc(true);
    await Bun.sleep(1);
  }
  return done();
}

describe("memo holds", () => {
  test("without holds, an entry lives as long as its key", () => {
    const memo = memoLifetime().heldObjectMemo<object, { n: number }>();
    const key = {};
    let made = 0;
    const v = memo.make(key, () => ({ n: ++made }));
    Bun.gc(true);
    expect(memo.get(key)).toBe(v);
    expect(made).toBe(1);
  });

  test("an entry a running unit read lives while it runs", () => {
    const { lifetime, unit } = tracked();
    const memo = lifetime.heldObjectMemo<object, { n: number }>();
    const key = {};
    const a = unit();
    const v = a.run(() => memo.make(key, () => ({ n: 1 })));
    expect(a.held.size).toBe(1);
    Bun.gc(true);
    expect(a.run(() => memo.get(key))).toBe(v);
  });

  test("a value-keyed entry nobody holds is collected, and its key dropped", async () => {
    const { lifetime, unit } = tracked();
    const memo = lifetime.heldValueMemo<string, { big: number[] }>();
    const a = unit();
    // Made in a frame of their own, so no stack slot of this one keeps them.
    (() => {
      for (let i = 0; i < 50; i++)
        a.run(() => memo.make(`f${i}`, () => ({ big: [i] })));
    })();
    a.release();
    // Asked from a unit of its own, let go at once: a read outside any unit
    // would pin what it finds.
    const gone = () => {
      const probe = unit();
      const live = probe.run(() =>
        Array.from({ length: 50 }, (_, i) => memo.has(`f${i}`)),
      );
      probe.release();
      return live.filter(Boolean).length < 50;
    };
    expect(await collectUntil(gone)).toBe(true);
  });

  test("a producer's reads are held by the entry it makes", async () => {
    const { lifetime, unit } = tracked();
    const inner = lifetime.heldValueMemo<string, { n: number }>();
    const outer = lifetime.heldValueMemo<string, { inner: number }>();
    const a = unit();
    (() => {
      for (let i = 0; i < 50; i++)
        a.run(() =>
          outer.make(`o${i}`, () => ({
            inner: inner.make(`i${i}`, () => ({ n: i })).n,
          })),
        );
    })();
    // The unit holds only the outer entries; the inner ones are theirs.
    expect(a.held.size).toBe(50);
    Bun.gc(true);
    for (let i = 0; i < 50; i++) expect(inner.get(`i${i}`)?.n).toBe(i);
  });

  test("a producer that throws stores nothing", () => {
    const { lifetime, unit } = tracked();
    const memo = lifetime.heldValueMemo<string, number>();
    const a = unit();
    expect(() =>
      a.run(() =>
        memo.make("k", () => {
          throw new Error("boom");
        }),
      ),
    ).toThrow("boom");
    expect(a.run(() => memo.has("k"))).toBe(false);
    expect(a.run(() => memo.make("k", () => 2))).toBe(2);
  });

  test("a forProcess entry outlives every holder", async () => {
    const { lifetime, unit } = tracked();
    const memo = lifetime.heldValueMemo<string, { n: number }>();
    const a = unit();
    (() => {
      for (let i = 0; i < 50; i++)
        a.run(() => memo.make(`p${i}`, () => ({ n: i }), { forProcess: true }));
    })();
    a.release();
    for (let i = 0; i < 5; i++) {
      Bun.gc(true);
      await Bun.sleep(1);
    }
    const probe = unit();
    for (let i = 0; i < 50; i++)
      expect(probe.run(() => memo.get(`p${i}`))?.n).toBe(i);
  });

  test("a memo keyed by another memo's value keeps that value's entry", async () => {
    const { lifetime, unit } = tracked();
    const passes = lifetime.heldValueMemo<string, { pass: number }>();
    const trees = lifetime.heldObjectMemo<object, { tree: number }>();
    const a = unit();
    const b = unit();
    // a makes the passes; b only builds trees keyed by them.
    const made = (() =>
      Array.from({ length: 20 }, (_, i) =>
        a.run(() => passes.make(`r${i}`, () => ({ pass: i }))),
      ))();
    (() => {
      for (const p of made)
        b.run(() => trees.make(p, () => ({ tree: p.pass })));
    })();
    made.length = 0;
    a.release();
    for (let i = 0; i < 5; i++) {
      Bun.gc(true);
      await Bun.sleep(1);
    }
    // b's trees hold the passes' entries: asking again answers the same pass,
    // so the trees keyed by it still hit.
    for (let i = 0; i < 20; i++) {
      const pass = b.run(() => passes.get(`r${i}`));
      expect(pass?.pass).toBe(i);
      expect(b.run(() => trees.get(pass!))?.tree).toBe(i);
    }
  });

  test("an entry read outside any unit is pinned", () => {
    const { lifetime } = tracked();
    const memo = lifetime.heldValueMemo<string, { n: number }>();
    memo.make("k", () => ({ n: 1 }));
    Bun.gc(true);
    expect(memo.get("k")?.n).toBe(1);
  });

  test("a second install throws", () => {
    const { lifetime } = tracked();
    expect(() =>
      lifetime.installMemoHolds({
        current: () => undefined,
        run: (_h, f) => f(),
      }),
    ).toThrow("already installed");
  });
});
