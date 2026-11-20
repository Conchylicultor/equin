import { describe, expect, test } from "bun:test";
import {
  clearCollectedContributions,
  clearPartialStart,
  collectContributions,
  declarePartialStart,
  defineServerContribution,
  isPartialStart,
  PartialListReadError,
} from "./contributions";

const Alpha = defineServerContribution<{ name: string }>("test.alpha");
const Beta = defineServerContribution<{ name: string }>("test.beta");

describe("ServerContributionToken.from", () => {
  test("reads only its own kind out of plugin definitions, with the payload", () => {
    const plugins = [
      { contributions: [Alpha({ name: "a1" }), Beta({ name: "b1" })] },
      {},
      { contributions: [Alpha({ name: "a2" })] },
    ];
    expect(Alpha.from(plugins).map((c) => c.name)).toEqual(["a1", "a2"]);
    expect(Beta.from(plugins).map((c) => c.name)).toEqual(["b1"]);
  });

  test("two tokens with the same debug name stay distinct", () => {
    const Twin = defineServerContribution<{ name: string }>("test.alpha");
    expect(Twin.from([{ contributions: [Alpha({ name: "a" })] }])).toEqual([]);
  });

  test("reads no boot state: independent of what was collected", () => {
    collectContributions([
      { id: "p", contributions: [Alpha({ name: "collected" })] },
    ]);
    expect(
      Alpha.from([{ contributions: [Alpha({ name: "given" })] }]).map(
        (c) => c.name,
      ),
    ).toEqual(["given"]);
  });
});

describe("a projected token", () => {
  // The contributor passes more than the kind keeps; every read — before and
  // after collection — returns the projected payload, and none is missing.
  const Projected = defineServerContribution<
    { name: string },
    { name: string; loader: () => void }
  >("test.projected", {
    project: (input) => ({ name: input.name }),
  });
  const plugins = [
    {
      id: "p",
      contributions: [Projected({ name: "x", loader: () => undefined })],
    },
  ];

  const projected = (cs: readonly object[] | undefined) =>
    cs?.map((c) => ({
      name: (c as { name: string }).name,
      hasLoader: "loader" in c,
    }));

  test("from() returns the projected payload", () => {
    expect(projected(Projected.from(plugins))).toEqual([
      { name: "x", hasLoader: false },
    ]);
  });

  test("getContributions and getContributionsIfCollected return it too", () => {
    collectContributions(plugins);
    expect(projected(Projected.getContributions())).toEqual([
      { name: "x", hasLoader: false },
    ]);
    expect(projected(Projected.getContributionsIfCollected())).toEqual([
      { name: "x", hasLoader: false },
    ]);
  });
});

describe("after collectContributions", () => {
  test("getContributions and getContributionsIfCollected agree; an absent kind is []", () => {
    collectContributions([{ id: "p", contributions: [Alpha({ name: "a" })] }]);
    expect(Alpha.getContributions().map((c) => c.name)).toEqual(["a"]);
    expect(Alpha.getContributionsIfCollected()?.map((c) => c.name)).toEqual([
      "a",
    ]);
    expect(Beta.getContributions()).toEqual([]);
    expect(Beta.getContributionsIfCollected()).toEqual([]);
  });
});

describe("a kind opened to companions", () => {
  const Owned = defineServerContribution<{ reason: string }>("test.owned", {
    companions: true,
  });

  test("a companion contribution carries the flag; the payload does not", () => {
    const c = Owned({ companion: true, reason: "r" });
    expect(c.companion).toBe(true);
    expect(Owned.from([{ contributions: [c] }]).map((p) => p.reason)).toEqual([
      "r",
    ]);
    expect(Owned({ reason: "plain" }).companion).toBeUndefined();
  });

  test("an unflagged kind rejects `companion` — at the type level, and loudly at runtime past a cast", () => {
    // @ts-expect-error — `companion` is an excess property on a kind not opened to companions.
    expect(() => Alpha({ name: "a", companion: true })).toThrow(
      /"test\.alpha" is not opened to companions/,
    );
  });
});

describe("the list rule (a partial start)", () => {
  const Whole = defineServerContribution<{ name: string }>("test.whole");
  const Own = defineServerContribution<{ name: string }>("test.own", {
    partial: { reason: "each entry is its contributor's own" },
  });

  test("a complete list missing a contributor throws, naming it and the fix; a partial one answers", () => {
    collectContributions([
      { id: "p", contributions: [Whole({ name: "w" }), Own({ name: "o" })] },
    ]);
    declarePartialStart({
      startedFrom: "job test.job (plugin p)",
      started: 1,
      total: 2,
      missingContributors: (kind) => (kind === "test.whole" ? ["q"] : []),
      fix: (kind) => `declare ${kind}`,
    });
    try {
      expect(isPartialStart()).toBe(true);
      expect(() => Whole.getContributions()).toThrow(PartialListReadError);
      expect(() => Whole.getContributionsIfCollected()).toThrow(
        /"test.whole" is a complete list.*\nNot started: 1 contributor \(q\)\.\nStarted from: job test.job \(plugin p\)\.\nFix: declare test.whole/,
      );
      expect(Own.getContributions().map((c) => c.name)).toEqual(["o"]);
      // The sanctioned "what did my own plugins declare" read.
      expect(Whole.startedContributions().map((c) => c.name)).toEqual(["w"]);
    } finally {
      clearPartialStart();
      clearCollectedContributions();
    }
    expect(isPartialStart()).toBe(false);
  });
});
