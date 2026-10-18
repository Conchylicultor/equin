import { describe, expect, test } from "bun:test";
import {
  MAIN_WORKTREE_NAME,
  asNamespace,
} from "@plugins/infra/plugins/namespace/core";
import type { OwnedNamespace } from "@plugins/infra/plugins/worktree/plugins/reclaim/server";
import {
  AUTO_REAP_AGE_MS,
  classifyAttempt,
  classifyOwnedNamespace,
  classifyStampedNamespace,
  NEEDS_HYGIENE,
  STAMPED_NAMESPACE_GRACE_MS,
  type AttemptFacts,
  type ClassifyContext,
  type ClassifyOwnedContext,
  type ClassifyResult,
  type ReapTarget,
} from "./reap-policy";
import {
  isSafeToReap,
  isTaskDeletable,
  SAFE_REAP_AGE_MS,
  type GitHygiene,
} from "./safety";

const NOW = Date.UTC(2026, 7, 17);
const WT = "/repo/.claude/worktrees/att-1-a";

const CLEAN: GitHygiene = { isDirty: false };
const DIRTY: GitHygiene = { isDirty: true };

function attempt(over: Partial<AttemptFacts> = {}): AttemptFacts {
  return {
    id: "att-1-a",
    worktreePath: WT,
    retained: false,
    createdAt: new Date(NOW - SAFE_REAP_AGE_MS),
    ...over,
  };
}

function ctx(over: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    hasDir: true,
    hasDB: true,
    hasRegistry: false,
    taskStatus: "done",
    now: NOW,
    ...over,
  };
}

const target = (a: AttemptFacts): ReapTarget => ({
  id: a.id,
  worktreePath: a.worktreePath,
});

describe("classifyAttempt — the four ways to become a target", () => {
  test("ORPHAN: dir gone but the fork DB lingers, at any age", () => {
    const a = attempt({ createdAt: new Date(NOW) }); // seconds old
    expect(classifyAttempt(a, ctx({ hasDir: false, hasDB: true }))).toEqual(
      target(a),
    );
  });

  test("ORPHAN: dir gone but only a registry entry lingers", () => {
    const a = attempt({ createdAt: new Date(NOW) });
    expect(
      classifyAttempt(
        a,
        ctx({ hasDir: false, hasDB: false, hasRegistry: true }),
      ),
    ).toEqual(target(a));
  });

  test("CLEAN PATH: dir present, pushed + clean + task done + ≥72h", () => {
    const a = attempt();
    expect(classifyAttempt(a, ctx({ hygiene: CLEAN }))).toEqual(target(a));
  });

  test("HARD FLOOR: ≥90d takes a dirty, held worktree", () => {
    const a = attempt({ createdAt: new Date(NOW - AUTO_REAP_AGE_MS) });
    expect(
      classifyAttempt(a, ctx({ taskStatus: "held", hygiene: DIRTY })),
    ).toEqual(target(a));
  });

  test("RETAINED outranks every branch, including the hard floor", () => {
    const a = attempt({
      retained: true,
      createdAt: new Date(NOW - 10 * AUTO_REAP_AGE_MS),
    });
    expect(classifyAttempt(a, ctx({ hygiene: CLEAN }))).toBeNull();
    expect(classifyAttempt(a, ctx({ hasDir: false }))).toBeNull();
  });

  test("nothing left to reclaim is not a target", () => {
    const a = attempt({ createdAt: new Date(NOW - 10 * AUTO_REAP_AGE_MS) });
    expect(
      classifyAttempt(
        a,
        ctx({ hasDir: false, hasDB: false, hasRegistry: false }),
      ),
    ).toBeNull();
  });
});

describe("classifyAttempt — when a git probe is asked for", () => {
  test("asks for hygiene only where the answer can move the verdict", () => {
    const a = attempt();
    expect(classifyAttempt(a, ctx())).toBe(NEEDS_HYGIENE);
  });

  test("no probe for a dir that is gone", () => {
    const a = attempt();
    expect(classifyAttempt(a, ctx({ hasDir: false }))).not.toBe(NEEDS_HYGIENE);
  });

  test("no probe past the hard floor — the verdict is already true", () => {
    const a = attempt({ createdAt: new Date(NOW - AUTO_REAP_AGE_MS) });
    expect(classifyAttempt(a, ctx())).toEqual(target(a));
  });

  test("no probe for a task that is not deletable — already false", () => {
    const a = attempt();
    expect(classifyAttempt(a, ctx({ taskStatus: "in_progress" }))).toBeNull();
  });

  test("no probe below 72h — already false", () => {
    const a = attempt({ createdAt: new Date(NOW - SAFE_REAP_AGE_MS + 1) });
    expect(classifyAttempt(a, ctx())).toBeNull();
  });

  test("a dirty tree past 72h is not a target", () => {
    const a = attempt();
    expect(classifyAttempt(a, ctx({ hygiene: DIRTY }))).toBeNull();
  });
});

// The pre-inversion classification, transcribed from the `pMap` closure it was
// extracted from. It always has the git answer in hand — that is exactly what
// made the old scan expensive — so it is the oracle for both halves of the
// equivalence sweep below.
function referenceClassify(
  a: AttemptFacts,
  c: ClassifyContext & { hygiene: GitHygiene },
): ReapTarget | null {
  if (a.retained) return null;
  if (!c.hasDir && !c.hasDB && !c.hasRegistry) return null;
  const age = c.now - a.createdAt.getTime();
  if (!c.hasDir) return { id: a.id, worktreePath: a.worktreePath };
  const taskDeletable = isTaskDeletable(c.taskStatus);
  const safe = isSafeToReap({
    dirExists: true,
    dbPresent: c.hasDB,
    isDirty: c.hygiene.isDirty,
    taskDeletable,
    ageMs: age,
    retained: false,
  });
  const hardFloor = age >= AUTO_REAP_AGE_MS;
  return safe || hardFloor ? { id: a.id, worktreePath: a.worktreePath } : null;
}

const BOOLS = [true, false];
const STATUSES = ["done", "dropped", "held", "in_progress", undefined];
const HYGIENES: GitHygiene[] = [CLEAN, DIRTY];
const AGES = [
  0,
  SAFE_REAP_AGE_MS - 1,
  SAFE_REAP_AGE_MS,
  AUTO_REAP_AGE_MS - 1,
  AUTO_REAP_AGE_MS,
  AUTO_REAP_AGE_MS * 2,
];

interface Combo {
  a: AttemptFacts;
  c: ClassifyContext;
}

function* combos(): Generator<Combo> {
  for (const retained of BOOLS)
    for (const hasDir of BOOLS)
      for (const hasDB of BOOLS)
        for (const hasRegistry of BOOLS)
          for (const taskStatus of STATUSES)
            for (const ageMs of AGES)
              yield {
                a: attempt({ retained, createdAt: new Date(NOW - ageMs) }),
                c: { hasDir, hasDB, hasRegistry, taskStatus, now: NOW },
              };
}

describe("classifyAttempt is bit-identical to the pre-inversion logic", () => {
  test("with hygiene in hand, every input agrees with the oracle", () => {
    let checked = 0;
    for (const { a, c } of combos()) {
      for (const hygiene of HYGIENES) {
        const got = classifyAttempt(a, { ...c, hygiene });
        expect(got).toEqual(referenceClassify(a, { ...c, hygiene }));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(900);
  });

  // The short-circuit's whole claim: where the probe is skipped, the answer
  // could not have depended on it. Proven by running the oracle with EVERY
  // hygiene value and demanding they all match the probe-free verdict.
  test("a skipped probe never changes the answer", () => {
    for (const { a, c } of combos()) {
      const got: ClassifyResult = classifyAttempt(a, c);
      if (got === NEEDS_HYGIENE) {
        // Asked for: the oracle is allowed to disagree with itself here, and the
        // probed verdict must match it for each possible answer.
        for (const hygiene of HYGIENES) {
          expect(classifyAttempt(a, { ...c, hygiene })).toEqual(
            referenceClassify(a, { ...c, hygiene }),
          );
        }
        continue;
      }
      for (const hygiene of HYGIENES) {
        expect(got).toEqual(referenceClassify(a, { ...c, hygiene }));
      }
    }
  });
});

// The marker-owned namespace branch: a namespace is reclaimed when the CHECKOUT
// that minted it disappears, and its provenance marker is the only thing that
// says which checkout that was.
function owned(marker: Partial<OwnedNamespace["marker"]> = {}): OwnedNamespace {
  return {
    ns: asNamespace("sonata.att-1-a"),
    marker: {
      composition: "sonata",
      checkout: "att-1-a",
      builtAt: new Date(NOW).toISOString(),
      buildId: "build-1",
      ...marker,
    },
  };
}

function ownedCtx(
  over: Partial<ClassifyOwnedContext> = {},
): ClassifyOwnedContext {
  return { checkoutDirExists: false, retained: false, ...over };
}

describe("classifyOwnedNamespace — reclaimed when its OWNER disappears", () => {
  test("a namespace whose checkout dir is gone is a target", () => {
    expect(classifyOwnedNamespace(owned(), ownedCtx())).toEqual({
      ns: asNamespace("sonata.att-1-a"),
      checkout: "att-1-a",
    });
  });

  test("a namespace whose checkout dir is still present is not a target", () => {
    expect(
      classifyOwnedNamespace(owned(), ownedCtx({ checkoutDirExists: true })),
    ).toBeNull();
  });

  test("a retained checkout's namespaces are not targets", () => {
    expect(
      classifyOwnedNamespace(owned(), ownedCtx({ retained: true })),
    ).toBeNull();
  });

  // `sonata` served from main holds real user content, and no checkout will ever
  // disappear to authorize its removal.
  test("checkout: null — owned by main — is NEVER a target", () => {
    expect(
      classifyOwnedNamespace(owned({ checkout: null }), ownedCtx()),
    ).toBeNull();
  });

  // Unknown is not absent. Guessing an owner here drops a database.
  test("checkout: undefined — a legacy marker — is NEVER a target", () => {
    expect(
      classifyOwnedNamespace(owned({ checkout: undefined }), ownedCtx()),
    ).toBeNull();
  });
});

describe("classifyStampedNamespace", () => {
  const NOW = 10 * STAMPED_NAMESPACE_GRACE_MS;
  const stale = {
    kind: "stamped" as const,
    root: "/tmp/gone",
    lastUsedMs: NOW - STAMPED_NAMESPACE_GRACE_MS,
  };
  const ns = asNamespace("e2e-clone");

  test("owner gone and unused past the grace → reclaimed as a checkout's own namespace", () => {
    expect(
      classifyStampedNamespace(ns, stale, { checkoutExists: false, now: NOW }),
    ).toEqual({ id: "e2e-clone" });
  });

  test("owner still on disk → kept", () => {
    expect(
      classifyStampedNamespace(ns, stale, { checkoutExists: true, now: NOW }),
    ).toBeNull();
  });

  test("used within the grace → kept, whatever the stat says", () => {
    const fresh = { ...stale, lastUsedMs: NOW - 1000 };
    expect(
      classifyStampedNamespace(ns, fresh, { checkoutExists: false, now: NOW }),
    ).toBeNull();
  });

  test("no stamp, or an unreadable one → kept: unknown owner is not a gone owner", () => {
    for (const owner of [
      { kind: "absent" as const },
      { kind: "malformed" as const, reason: "not JSON" },
    ]) {
      expect(
        classifyStampedNamespace(ns, owner, {
          checkoutExists: false,
          now: NOW,
        }),
      ).toBeNull();
    }
  });

  test("the main namespace is never a target, even if its checkout moved", () => {
    expect(
      classifyStampedNamespace(MAIN_WORKTREE_NAME, stale, {
        checkoutExists: false,
        now: NOW,
      }),
    ).toBeNull();
  });
});
