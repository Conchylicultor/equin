import { describe, expect, test } from "bun:test";
import {
  collectContributions,
  defineServerContribution,
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
