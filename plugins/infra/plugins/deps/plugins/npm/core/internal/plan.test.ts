import { describe, expect, test } from "bun:test";
import { planNpm, type Packument, type PlanInput } from "./plan";
import type { Group, Hold } from "./policy";

const OLD = "2026-01-01T00:00:00.000Z";
const CUTOFF = "2026-10-13T00:00:00.000Z";
const FRESH = "2026-10-15T00:00:00.000Z";

function pkg(latest: string, versions: Record<string, string>): Packument {
  return { latest, published: new Map(Object.entries(versions)) };
}

function input(over: Partial<PlanInput>): PlanInput {
  return {
    installed: [],
    packuments: new Map(),
    groups: [],
    holds: [],
    patched: new Map(),
    cutoff: CUTOFF,
    today: "2026-10-16",
    ...over,
  };
}

describe("planNpm", () => {
  test("moves to the newest release past the cooldown, majors included", () => {
    const plan = planNpm(
      input({
        installed: [{ name: "vite", current: "6.4.2" }],
        packuments: new Map([
          [
            "vite",
            pkg("7.2.0", { "6.4.2": OLD, "7.1.0": OLD, "7.2.0": FRESH }),
          ],
        ]),
      }),
    );
    expect(plan.moves).toEqual([{ name: "vite", from: "6.4.2", to: "7.1.0" }]);
    expect(plan.outdated).toEqual([
      { name: "vite", current: "6.4.2", latest: "7.1.0" },
    ]);
  });

  test("skips prereleases and anything past dist-tags.latest", () => {
    const plan = planNpm(
      input({
        installed: [{ name: "x", current: "1.0.0" }],
        packuments: new Map([
          [
            "x",
            pkg("1.1.0", {
              "1.0.0": OLD,
              "1.1.0": OLD,
              "2.0.0-rc.1": OLD,
              "1.2.0": OLD,
            }),
          ],
        ]),
      }),
    );
    expect(plan.moves).toEqual([{ name: "x", from: "1.0.0", to: "1.1.0" }]);
  });

  test("a held release is reported HELD, the move stops below it", () => {
    const hold: Hold = {
      packages: ["react"],
      below: "20.0.0",
      reason: "waits on x",
      until: "2026-12-01",
    };
    const plan = planNpm(
      input({
        installed: [{ name: "react", current: "19.1.0" }],
        packuments: new Map([
          [
            "react",
            pkg("20.0.0", { "19.1.0": OLD, "19.2.0": OLD, "20.0.0": OLD }),
          ],
        ]),
        holds: [hold],
      }),
    );
    expect(plan.moves).toEqual([
      { name: "react", from: "19.1.0", to: "19.2.0" },
    ]);
    expect(plan.outdated).toContainEqual({
      name: "react",
      current: "19.1.0",
      latest: "20.0.0",
      waiting: { kind: "held", reason: "waits on x", until: "2026-12-01" },
    });
  });

  test("an expired hold is inert", () => {
    const plan = planNpm(
      input({
        installed: [{ name: "react", current: "19.1.0" }],
        packuments: new Map([
          ["react", pkg("20.0.0", { "19.1.0": OLD, "20.0.0": OLD })],
        ]),
        holds: [
          {
            packages: ["react"],
            below: "20.0.0",
            reason: "r",
            until: "2026-10-15",
          },
        ],
      }),
    );
    expect(plan.moves).toEqual([
      { name: "react", from: "19.1.0", to: "20.0.0" },
    ]);
    expect(plan.outdated.every((o) => o.waiting === undefined)).toBe(true);
  });

  const pg: Group[] = [
    {
      id: "server",
      members: ["srv-a", "srv-b"],
      agree: "version",
      reason: "r",
    },
    {
      id: "release",
      members: ["cli", "srv-a", "srv-b"],
      agree: "major.minor",
      reason: "r",
      prerequisite: "publish cli",
    },
  ];
  const pgInstalled = [
    { name: "cli", current: "18.3.0" },
    { name: "srv-a", current: "18.3.0-beta.17" },
    { name: "srv-b", current: "18.3.0-beta.17" },
  ];

  test("a group moves as one unit, to the newest release every member agrees on", () => {
    const srv = pkg("18.4.0-beta.1", {
      "18.3.0-beta.17": OLD,
      "18.4.0-beta.1": OLD,
    });
    const plan = planNpm(
      input({
        installed: pgInstalled,
        packuments: new Map([
          ["cli", pkg("18.4.0", { "18.3.0": OLD, "18.4.0": OLD })],
          ["srv-a", srv],
          ["srv-b", srv],
        ]),
        groups: pg,
      }),
    );
    expect(plan.moves).toEqual([
      { name: "cli", from: "18.3.0", to: "18.4.0", unit: "cli" },
      {
        name: "srv-a",
        from: "18.3.0-beta.17",
        to: "18.4.0-beta.1",
        unit: "cli",
      },
      {
        name: "srv-b",
        from: "18.3.0-beta.17",
        to: "18.4.0-beta.1",
        unit: "cli",
      },
    ]);
  });

  test("a member a partner has not caught up with is BLOCKED with the group's prerequisite", () => {
    const srv = pkg("18.4.0-beta.1", {
      "18.3.0-beta.17": OLD,
      "18.4.0-beta.1": OLD,
    });
    const plan = planNpm(
      input({
        installed: pgInstalled,
        packuments: new Map([
          ["cli", pkg("18.3.0", { "18.3.0": OLD })],
          ["srv-a", srv],
          ["srv-b", srv],
        ]),
        groups: pg,
      }),
    );
    expect(plan.moves).toEqual([]);
    expect(plan.outdated).toContainEqual({
      name: "srv-a",
      current: "18.3.0-beta.17",
      latest: "18.4.0-beta.1",
      waiting: { kind: "blocked", prerequisite: "publish cli" },
    });
  });

  test("a patched package's move is BLOCKED on porting the patch", () => {
    const plan = planNpm(
      input({
        installed: [{ name: "p", current: "7.1.1" }],
        packuments: new Map([
          ["p", pkg("7.2.0", { "7.1.1": OLD, "7.2.0": OLD })],
        ]),
        patched: new Map([
          ["p", { version: "7.1.1", patch: "patches/p@7.1.1.patch" }],
        ]),
      }),
    );
    expect(plan.moves).toEqual([]);
    expect(plan.outdated[0]?.waiting?.kind).toBe("blocked");
  });
});
