import { describe, expect, test } from "bun:test";
import {
  deployEachTarget,
  ownTargetFirst,
  type TargetFailure,
} from "./fan-out";

interface T {
  namespace: string;
  isMainComposition: boolean;
}
const main: T = { namespace: "equin", isMainComposition: true };
const sonata: T = { namespace: "sonata", isMainComposition: false };
const website: T = { namespace: "website", isMainComposition: false };

const fail = (why: string) => ({
  ok: false as const,
  reason: [why],
  failedLabels: [why],
});

describe("ownTargetFirst", () => {
  test("puts the checkout's own app first, the rest in order", () => {
    expect(ownTargetFirst([sonata, main, website])).toEqual([
      main,
      sonata,
      website,
    ]);
    expect(ownTargetFirst([sonata, website])).toEqual([sonata, website]);
  });
});

describe("deployEachTarget", () => {
  test("a later target failing does not stop the rest, and main stays deployed", async () => {
    const seen: string[] = [];
    const out = await deployEachTarget([main, sonata, website], async (t) => {
      seen.push(t.namespace);
      return t === sonata ? fail("sonata health") : { ok: true };
    });
    expect(seen).toEqual(["equin", "sonata", "website"]);
    expect(out.deployed).toEqual([main, website]);
    expect(out.failed.map((f) => f.target)).toEqual([sonata]);
    expect(out.notAttempted).toEqual([]);
  });

  test("the first target (it carries the tree's validation) failing stops the fan-out", async () => {
    const seen: string[] = [];
    const out = await deployEachTarget([main, sonata, website], async (t) => {
      seen.push(t.namespace);
      return fail("checks");
    });
    expect(seen).toEqual(["equin"]);
    expect(out.deployed).toEqual([]);
    expect(out.failed.map((f) => f.target)).toEqual([main]);
    expect(out.notAttempted).toEqual([sonata, website]);
  });

  test("a target whose preparation failed is recorded failed and never deployed", async () => {
    const seen: string[] = [];
    const prepared = new Map<T, TargetFailure<T>>([
      [sonata, { target: sonata, reason: ["registry"], failedLabels: ["r"] }],
    ]);
    const out = await deployEachTarget(
      [main, sonata, website],
      async (t) => {
        seen.push(t.namespace);
        return { ok: true };
      },
      prepared,
    );
    expect(seen).toEqual(["equin", "website"]);
    expect(out.deployed).toEqual([main, website]);
    expect(out.failed.map((f) => f.target)).toEqual([sonata]);
  });

  test("a prepared failure after a stopping one is still reported failed, not unattempted", async () => {
    const prepared = new Map<T, TargetFailure<T>>([
      [website, { target: website, reason: ["registry"], failedLabels: ["r"] }],
    ]);
    const out = await deployEachTarget(
      [main, sonata, website],
      async () => fail("checks"),
      prepared,
    );
    expect(out.failed.map((f) => f.target)).toEqual([main, website]);
    expect(out.notAttempted).toEqual([sonata]);
  });

  test("a prepared failure of targets[0] moves the validation and the stop rule to the next target attempted", async () => {
    const seen: { namespace: string; first: boolean }[] = [];
    const prepared = new Map<T, TargetFailure<T>>([
      [sonata, { target: sonata, reason: ["registry"], failedLabels: ["r"] }],
    ]);
    const out = await deployEachTarget(
      [sonata, website, main],
      async (t, { first }) => {
        seen.push({ namespace: t.namespace, first });
        return fail("checks");
      },
      prepared,
    );
    // website is the first attempted: it carries the validation, and its
    // failure stops the fan-out — main is never deployed from that tree.
    expect(seen).toEqual([{ namespace: "website", first: true }]);
    expect(out.deployed).toEqual([]);
    expect(out.failed.map((f) => f.target)).toEqual([sonata, website]);
    expect(out.notAttempted).toEqual([main]);
  });

  test("only the first attempted target is told first", async () => {
    const firsts: boolean[] = [];
    await deployEachTarget([main, sonata, website], async (_t, { first }) => {
      firsts.push(first);
      return { ok: true };
    });
    expect(firsts).toEqual([true, false, false]);
  });
});
