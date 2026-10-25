import { test, expect } from "bun:test";
import {
  withHostGrant,
  inheritedGrant,
} from "@plugins/infra/plugins/host/plugins/host-admission/server";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { withEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core/testing";

// `withHostGrant` touches the real host `cpu` pool (flock slot files), so keep
// its footprint minimal — request a single slot on the background lane. Its only
// job here is to prove `units >= 1` and that `run` executes `fn`. The grant
// arithmetic (concurrency bound, env round-trip, env parsing) is exercised
// through `inheritedGrant`, which is pure in-process and touches NO flock.

test("withHostGrant grants at least one unit and runs fn", async () => {
  const result = await withHostGrant(
    { lane: "background", priority: "normal", max: 1 },
    async (g) => {
      expect(g.units).toBeGreaterThanOrEqual(1);
      return g.run(async () => 42);
    },
  );
  expect(result).toBe(42);
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
