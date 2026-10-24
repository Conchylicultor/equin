import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { mintReachPlan } from "@plugins/framework/plugins/resource-runtime/core";
import { collectContributions } from "./contributions";
import {
  Resource,
  assertServedReadsHaveWatermarkSource,
  assertPreloadedResourcesDeclared,
  clearRelationBases,
  defineResource,
  handleResourceHttp,
  setLiveStateSnapshotHooks,
  setRelationBases,
  setWatermarkSource,
  undeclaredPreloadedKeys,
} from "./resources";

describe("undeclaredPreloadedKeys", () => {
  test("names each preloaded key no Declare carries, sorted", () => {
    expect(
      undeclaredPreloadedKeys(
        ["b", "declared", "a"],
        [{ key: "declared", mode: "push", preload: "boot" }],
      ),
    ).toEqual(["a", "b"]);
  });

  test("a Declare that lost its preload flag does not count", () => {
    expect(
      undeclaredPreloadedKeys(["k"], [{ key: "k", mode: "push" }]),
    ).toEqual(["k"]);
  });

  test("either preload value counts, and non-preloaded Declares are irrelevant", () => {
    expect(
      undeclaredPreloadedKeys(
        ["boot", "kept"],
        [
          { key: "boot", mode: "push", preload: "boot" },
          { key: "kept", mode: "keyed", preload: "boot-and-keep" },
          { key: "other", mode: "invalidate" },
        ],
      ),
    ).toEqual([]);
  });
});

// Through the facade's own runtime and Declare token, as boot calls it. The
// runtime is a process singleton other suites may also register preloaded
// resources on, so each expectation is scoped to this suite's own key.
describe("assertPreloadedResourcesDeclared", () => {
  const key = "server-core-test.preload-declare";
  const preloaded = defineResource(
    { key, schema: z.number(), preload: "boot", validateParams: () => {} },
    { mode: "push", loader: () => 1 },
  );
  const named = `"${key}"`;

  test("throws naming a registered preloaded resource with no Declare, and says how to fix it", () => {
    collectContributions([{ id: "test/plugin", contributions: [] }]);
    expect(assertPreloadedResourcesDeclared).toThrow(named);
    expect(assertPreloadedResourcesDeclared).toThrow("...served.declare");
  });

  test("its Declare clears it", () => {
    collectContributions([
      { id: "test/plugin", contributions: [Resource.Declare(preloaded)] },
    ]);
    expect(assertPreloadedResourcesDeclared).not.toThrow(named);
  });
});

// Every read a contribution token publishes works on `Resource.Declare` —
// each used to be copied by hand onto a wrapper, and two were missing at
// runtime while still type-checking.
describe("Resource.Declare reads", () => {
  const key = "server-core-test.declare-reads";
  const served = defineResource(
    { key, schema: z.number(), preload: "boot", validateParams: () => {} },
    { mode: "push", loader: () => 1 },
  );
  const plugins = [
    { id: "test/plugin", contributions: [Resource.Declare(served)] },
  ];
  const payload = { key, mode: "push", preload: "boot" };

  test("from() reads the payload off plugin definitions — and only the payload", () => {
    const [declared] = Resource.Declare.from(plugins);
    expect(declared).toMatchObject(payload);
    expect("loader" in declared!).toBe(false);
  });

  test("getContributionsIfCollected() and getContributions() agree after collection", () => {
    collectContributions(plugins);
    const mine = (cs: readonly { key: string }[] | undefined) =>
      cs?.filter((c) => c.key === key);
    expect(mine(Resource.Declare.getContributionsIfCollected())).toEqual(
      mine(Resource.Declare.getContributions()),
    );
    expect(mine(Resource.Declare.getContributions())).toEqual([
      expect.objectContaining(payload),
    ]);
  });
});

describe("setRelationBases", () => {
  // The holder is process-global: leave it unset for the next suite.
  afterAll(clearRelationBases);
  // D2: a reach plan's relation reads expand through the bases once set.
  test("a reach plan's relation reads expand through the new bases", async () => {
    defineResource(
      {
        key: "set-relation-bases-probe",
        schema: z.number(),
        validateParams: () => {},
      },
      {
        mode: "push",
        reach: mintReachPlan({
          routes: [],
          usesOf: () => new Map(),
          relations: [{ relation: "probe_v", reason: "reads probe_v whole" }],
        }),
        loader: () => 1,
      },
    );
    setRelationBases((r) => (r === "probe_v" ? ["probe_a", "probe_b"] : [r]));
    const res = await handleResourceHttp(
      new Request("http://localhost/api/resources/_debug"),
      { key: "_debug" },
    );
    const body = (await res.json()) as {
      resources: Array<{
        key: string;
        relationReads: Array<{
          relation: string;
          reason: string;
          bases: string[];
        }>;
      }>;
    };
    expect(
      body.resources.find((r) => r.key === "set-relation-bases-probe")
        ?.relationReads,
    ).toEqual([
      {
        relation: "probe_v",
        reason: "reads probe_v whole",
        bases: ["probe_a", "probe_b"],
      },
    ]);
  });
});

describe("setWatermarkSource", () => {
  // The holders are process-global: leave them unset for the next suite.
  afterAll(() => {
    setWatermarkSource(null);
    setLiveStateSnapshotHooks(null);
  });
  // A served resource, so the boot assert has something to judge.
  const key = "set-watermark-source-probe";
  defineResource(
    { key, schema: z.number(), validateParams: () => {} },
    { mode: "push", loader: () => 7 },
  );

  test("a host serving live reads fails boot without a source, naming the setter", () => {
    setWatermarkSource(null);
    expect(assertServedReadsHaveWatermarkSource).toThrow("setWatermarkSource");
    setWatermarkSource(async () => "1");
    expect(assertServedReadsHaveWatermarkSource).not.toThrow();
  });

  test("frames keep the source's watermark after L2's hooks are uninstalled (a degraded L2)", async () => {
    // What a failed L2 init does: install its hooks, then reset them to null.
    setLiveStateSnapshotHooks({
      shouldPersist: () => false,
      persistSnapshot: async () => {},
    });
    setLiveStateSnapshotHooks(null);
    setWatermarkSource(async () => "4242");
    const res = await handleResourceHttp(
      new Request(`http://localhost/api/resources/${key}`),
      { key },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { value: unknown; watermark?: string };
    expect(body.value).toBe(7);
    expect(body.watermark).toBe("4242");
  });
});
