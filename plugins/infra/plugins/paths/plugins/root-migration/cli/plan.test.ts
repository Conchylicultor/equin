import { describe, expect, test } from "bun:test";
import { describePlan, planRootMigration, type MigrationFacts } from "./plan";

const H = "/home/u";
const LEGACY = `${H}/.old`;
const CURRENT = `${H}/.equin`;
const BACKUPS = {
  legacy: `${H}/.backups/old`,
  current: `${H}/.backups/equin`,
  legacyExists: false,
  legacyIsLink: false,
  currentExists: false,
};

function facts(over: Partial<MigrationFacts>): MigrationFacts {
  return {
    layout: { kind: "legacy", root: LEGACY, current: CURRENT },
    backups: BACKUPS,
    oldLabelInstalled: true,
    runByAgent: false,
    cwdInsideRoot: null,
    liveWork: [],
    liveAgents: [],
    stopAgents: false,
    staleCheckouts: [],
    ...over,
  };
}

describe("planRootMigration", () => {
  test("an install not yet migrated: move, rewrite, drop the link, relabel", () => {
    expect(planRootMigration(facts({}))).toEqual({
      kind: "migrate",
      root: { from: LEGACY, to: CURRENT },
      backups: null,
      rewrite: [{ from: LEGACY, to: CURRENT }],
      dropLinks: [LEGACY],
      keptLinks: null,
      relabel: true,
      stopAgents: [],
    });
  });

  test("open agents block unless --stop-agents, which stops them with the app", () => {
    const agent = { what: "agent conv-1 of ns (pid 7)", pid: 7 };
    expect(planRootMigration(facts({ liveAgents: [agent] })).kind).toBe(
      "refuse",
    );
    expect(
      planRootMigration(facts({ liveAgents: [agent], stopAgents: true })),
    ).toMatchObject({ kind: "migrate", stopAgents: [agent] });
  });

  test("its local backups move with it", () => {
    const plan = planRootMigration(
      facts({ backups: { ...BACKUPS, legacyExists: true } }),
    );
    expect(plan).toMatchObject({
      backups: { from: BACKUPS.legacy, to: BACKUPS.current },
      dropLinks: [LEGACY, BACKUPS.legacy],
    });
  });

  test("a run whose scan kept the link: rewrite again, no move", () => {
    const plan = planRootMigration(
      facts({
        layout: {
          kind: "current",
          root: CURRENT,
          legacy: LEGACY,
          legacyLink: true,
        },
        oldLabelInstalled: false,
      }),
    );
    expect(plan).toEqual({
      kind: "migrate",
      root: null,
      backups: null,
      rewrite: [{ from: LEGACY, to: CURRENT }],
      dropLinks: [LEGACY],
      keptLinks: null,
      relabel: false,
      stopAgents: [],
    });
  });

  test("moved but still under the old label: only relabel", () => {
    const plan = planRootMigration(
      facts({
        layout: {
          kind: "current",
          root: CURRENT,
          legacy: LEGACY,
          legacyLink: false,
        },
      }),
    );
    expect(plan).toMatchObject({
      kind: "migrate",
      root: null,
      rewrite: [],
      relabel: true,
    });
  });

  test("a fresh or finished install: nothing to do", () => {
    expect(
      planRootMigration(
        facts({
          layout: {
            kind: "current",
            root: CURRENT,
            legacy: LEGACY,
            legacyLink: false,
          },
          oldLabelInstalled: false,
        }),
      ),
    ).toEqual({ kind: "done", keptLinks: null });
  });

  describe("while checkouts still run code from before the move", () => {
    const stale = Array.from({ length: 7 }, (_, i) => ({
      path: `/r/repo/.claude/worktrees/att-${i}`,
      head: `${i}`.repeat(40),
    }));
    const linked = {
      kind: "current" as const,
      root: CURRENT,
      legacy: LEGACY,
      legacyLink: true,
    };

    test("an install not yet migrated moves, but keeps every legacy link", () => {
      const plan = planRootMigration(
        facts({
          staleCheckouts: stale,
          backups: { ...BACKUPS, legacyExists: true },
        }),
      );
      expect(plan).toMatchObject({
        kind: "migrate",
        root: { from: LEGACY, to: CURRENT },
        dropLinks: [],
        keptLinks: { links: [LEGACY, BACKUPS.legacy], staleCheckouts: stale },
      });
    });

    test("none left: the link is dropped", () => {
      expect(
        planRootMigration(facts({ layout: linked, oldLabelInstalled: false })),
      ).toMatchObject({ dropLinks: [LEGACY], keptLinks: null });
    });

    test("migrated with the link: nothing is rewritten or dropped", () => {
      const plan = planRootMigration(
        facts({
          layout: linked,
          oldLabelInstalled: false,
          staleCheckouts: stale,
          backups: { ...BACKUPS, legacyIsLink: true },
        }),
      );
      expect(plan).toEqual({
        kind: "done",
        keptLinks: { links: [LEGACY, BACKUPS.legacy], staleCheckouts: stale },
      });
    });

    test("migrated with the link and the old label: only the relabel", () => {
      expect(
        planRootMigration(facts({ layout: linked, staleCheckouts: stale })),
      ).toEqual({
        kind: "migrate",
        root: null,
        backups: null,
        rewrite: [],
        dropLinks: [],
        keptLinks: { links: [LEGACY], staleCheckouts: stale },
        relabel: true,
        stopAgents: [],
      });
    });

    test("the plan says why, names a sample and how to clear them", () => {
      const text = describePlan(
        planRootMigration(
          facts({
            layout: linked,
            oldLabelInstalled: false,
            staleCheckouts: stale,
          }),
        ),
      );
      expect(text).toContain(`Keep ${LEGACY} as a link`);
      expect(text).toContain("7 checkout(s)");
      expect(text).toContain(stale[4]!.path);
      expect(text).not.toContain(stale[5]!.path);
      expect(text).toContain("…and 2 more");
      expect(text).toContain("./equin build");
    });
  });

  test("refuses, with every reason at once", () => {
    const plan = planRootMigration(
      facts({
        runByAgent: true,
        cwdInsideRoot: `${LEGACY}/state`,
        liveWork: [{ what: "build in att-x (pid 1)" }],
        backups: { ...BACKUPS, legacyExists: true, currentExists: true },
      }),
    );
    expect(plan.kind).toBe("refuse");
    expect(plan.kind === "refuse" && plan.reasons.length).toBe(4);
  });

  test("refuses a split root and an environment-set root", () => {
    expect(
      planRootMigration(facts({ layout: { kind: "split", message: "two" } }))
        .kind,
    ).toBe("refuse");
    expect(
      planRootMigration(facts({ layout: { kind: "custom", root: "/tmp/x" } }))
        .kind,
    ).toBe("refuse");
  });
});
