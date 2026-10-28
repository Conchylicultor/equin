import { test, expect } from "bun:test";
import { inheritedGrant } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { withEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core/testing";
import { withPoolGrant } from "./grant";

// Nothing here touches the real host `cpu` pool: its result would depend on
// what the rest of the box holds (a build keeps background-lane slots for tens
// of minutes), not on this code. `withPoolGrant` — `withHostGrant`'s body over
// any `acquireShare` — runs against a fake share; the flock acquire itself is
// host-semaphore's to test, on its own throwaway slot dirs. The grant
// arithmetic (concurrency bound, env round-trip, env parsing) is exercised
// through `inheritedGrant`, which is pure in-process.

// A pool whose share is `slots` wide, recording what was asked and released.
function fakePool(slots: number) {
  const calls = { max: [] as number[], lanes: [] as unknown[], released: 0 };
  return {
    calls,
    acquireShare: async (max: number, hooks?: { lane?: unknown }) => {
      calls.max.push(max);
      calls.lanes.push(hooks?.lane);
      return {
        slots,
        release: async () => {
          calls.released++;
        },
        releaseSlots: () => {},
      };
    },
  };
}

test("withPoolGrant grants the share's units, runs fn and releases the share", async () => {
  const pool = fakePool(2);
  const result = await withPoolGrant(
    pool,
    { lane: "background", priority: "normal", max: 3 },
    async (g) => {
      expect(g.units).toBe(2);
      expect(g.lane).toBe("background");
      expect(g.env()).toEqual(
        envEntries({ HOST_GRANT: "2", LANE: "background" }),
      );
      return g.run(async () => 42);
    },
  );
  expect(result).toBe(42);
  expect(pool.calls.max).toEqual([3]);
  expect(pool.calls.lanes).toEqual(["background"]);
  expect(pool.calls.released).toBe(1);
});

test("withPoolGrant releases the share when fn throws", async () => {
  const pool = fakePool(1);
  const err = await withPoolGrant(
    pool,
    { lane: "background", priority: "normal", max: 1 },
    async () => {
      throw new Error("boom");
    },
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe("boom");
  expect(pool.calls.released).toBe(1);
});

test("inheritedGrant reads the HOST_GRANT key and bounds grant.run to units", async () => {
  await withEnv({ HOST_GRANT: "3", LANE: "interactive" }, async () => {
    const g = inheritedGrant();
    expect(g).toBeDefined();
    expect(g!.units).toBe(3);
    // The lane is a field, not only an env string: a child reads lane-shaped
    // decisions (its type-check worker's slot and priority) off the grant.
    expect(g!.lane).toBe("interactive");
    // The env it hands a child round-trips the very values it was built from.
    expect(g!.env()).toEqual(
      envEntries({ HOST_GRANT: "3", LANE: "interactive" }),
    );

    // 9 tasks through a 3-unit grant: concurrency must never exceed 3.
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 9 }, () =>
        g!.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 15));
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });
});

// A grant built from an env count, with the env restored afterwards. Pure
// in-process (no flock), so the weighted-spend cases below cost nothing.
async function withInheritedUnits(
  units: number,
  body: (
    grant: NonNullable<ReturnType<typeof inheritedGrant>>,
  ) => Promise<void>,
): Promise<void> {
  await withEnv({ HOST_GRANT: String(units) }, async () => {
    const grant = inheritedGrant();
    expect(grant).toBeDefined();
    await body(grant!);
  });
}

test("a 1-unit grant runs a 2-unit request rather than waiting forever", async () => {
  await withInheritedUnits(1, async (grant) => {
    // The grant IS the ceiling: the spend clamps to the units held, so a heavy
    // child on a reduced grant just runs at weight 1. Without the clamp this
    // would queue for capacity that can never appear, and the test would hang.
    expect(await grant.run(async () => "ran", { units: 2 })).toBe("ran");
    // And the grant is intact afterwards — the clamped spend was released.
    expect(await grant.run(async () => "again")).toBe("again");
  });
});

test("a 3-unit grant bounds concurrency by WEIGHT, not by call count", async () => {
  await withInheritedUnits(3, async (grant) => {
    let heavyActive = 0;
    let heavyPeak = 0;
    let units = 0;
    let unitPeak = 0;

    const heavy = () =>
      grant.run(
        async () => {
          heavyActive++;
          units += 2;
          heavyPeak = Math.max(heavyPeak, heavyActive);
          unitPeak = Math.max(unitPeak, units);
          await new Promise((r) => setTimeout(r, 15));
          units -= 2;
          heavyActive--;
        },
        { units: 2 },
      );
    const light = () =>
      grant.run(async () => {
        units++;
        unitPeak = Math.max(unitPeak, units);
        await new Promise((r) => setTimeout(r, 15));
        units--;
      });

    await Promise.all([heavy(), heavy(), light(), light(), heavy()]);

    // Two 2-unit children cannot fit in 3 units, so they serialize...
    expect(heavyPeak).toBe(1);
    // ...and no instant ever exceeded the grant's units.
    expect(unitPeak).toBeLessThanOrEqual(3);
    expect(unitPeak).toBeGreaterThan(0);
  });
});

test("grant.run rejects a nonsense unit count", async () => {
  await withInheritedUnits(2, async (grant) => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => grant.run(async () => {}, { units: bad })).toThrow(
        /positive integer/,
      );
    }
  });
});

test("inheritedGrant defaults the lane to background when the LANE key is unset", async () => {
  await withEnv({ HOST_GRANT: "2", LANE: undefined }, () => {
    const g = inheritedGrant();
    expect(g?.lane).toBe("background");
    expect(g?.env()).toEqual(
      envEntries({ HOST_GRANT: "2", LANE: "background" }),
    );
  });
});

test("inheritedGrant returns undefined for absent or invalid HOST_GRANT", async () => {
  await withEnv({ HOST_GRANT: undefined }, () => {
    expect(inheritedGrant()).toBeUndefined();
  });
  for (const bad of ["0", "-1", "abc", "", "1.5", " "]) {
    await withEnv({ HOST_GRANT: bad }, () => {
      expect(inheritedGrant()).toBeUndefined();
    });
  }
});
