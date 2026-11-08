import { describe, expect, test } from "bun:test";
import {
  liveStatusFor,
  planConversationUpdate,
  sessionCandidate,
  STUCK_TURN_MS,
  type Liveness,
  type PlanContext,
  type PlanRow,
  type UpdatePlan,
} from "./plan-update";
import type { RuntimeInfo } from "./runtime";
import { STUCK_TURN_WAITING_FOR } from "../../core/turn-gate";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const SESSION = "a4ee9684-418d-4661-b372-2960760538a7";
const NEW_SESSION = "0b1c2d3e-0000-4000-8000-000000000001";

function row(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    status: "waiting",
    closeRequested: false,
    claudeSessionId: SESSION,
    waitingFor: null,
    workingOn: null,
    createdAt: new Date(NOW - 60 * 60_000),
    hibernatedAt: null,
    resumingSince: null,
    statusUnverifiedSince: null,
    ...overrides,
  };
}

function live(overrides: Partial<RuntimeInfo> = {}): Liveness {
  return {
    kind: "live",
    info: {
      workingOn: null,
      dead: false,
      claudeSessionId: SESSION,
      statusWrittenAt: null,
      ...overrides,
    },
  };
}

const ABSENT: Liveness = { kind: "absent" };
const UNKNOWN: Liveness = { kind: "unknown", reason: "behind" };

function ctx(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    forkedAt: null,
    now: NOW,
    sessionAccepted: false,
    questionHold: null,
    lastSubmitAt: null,
    pendingTurnSince: null,
    spawnInFlight: false,
    inlineLaunchInFlight: false,
    ...overrides,
  };
}

describe("planConversationUpdate — done is never overwritten", () => {
  test.each([
    ["live", live({ workingOn: "turn" })],
    ["dead", live({ dead: true })],
    ["absent", ABSENT],
    ["unknown", UNKNOWN],
  ] as const)("%s", (_label, l) => {
    expect(planConversationUpdate(row({ status: "done" }), l, ctx())).toEqual({
      kind: "noop",
    });
  });
});

describe("planConversationUpdate — live session", () => {
  test("in sync → noop", () => {
    expect(planConversationUpdate(row(), live(), ctx())).toEqual({
      kind: "noop",
    });
  });

  test("waiting → working", () => {
    expect(
      planConversationUpdate(row(), live({ workingOn: "turn" }), ctx()),
    ).toMatchObject({ kind: "patch", patch: { status: "working" } });
  });

  test("a turn ending with background tasks pending stays working, on background", () => {
    expect(
      planConversationUpdate(
        row({ status: "working", workingOn: "turn" }),
        live({ workingOn: "background" }),
        ctx(),
      ),
    ).toEqual({
      kind: "patch",
      patch: { status: "working", workingOn: "background" },
      adoptedSessionId: null,
    });
  });

  test("background work finishing (nothing else to do) waits on the user", () => {
    expect(
      planConversationUpdate(
        row({ status: "working", workingOn: "background" }),
        live(),
        ctx(),
      ),
    ).toEqual({
      kind: "patch",
      patch: { status: "waiting" },
      adoptedSessionId: null,
    });
  });

  test("a turn submitted while background work runs is a running turn", () => {
    expect(
      planConversationUpdate(
        row({ status: "working", workingOn: "background" }),
        live({
          workingOn: "background",
          statusWrittenAt: new Date(NOW - 50),
        }),
        ctx({ lastSubmitAt: new Date(NOW) }),
      ),
    ).toMatchObject({
      kind: "patch",
      patch: { status: "working", workingOn: "turn" },
    });
  });

  test("working → waiting", () => {
    expect(
      planConversationUpdate(row({ status: "working" }), live(), ctx()),
    ).toEqual({
      kind: "patch",
      patch: { status: "waiting" },
      adoptedSessionId: null,
    });
  });

  test("a held question waits on a question", () => {
    for (const agent of [live(), live({ workingOn: "turn" })]) {
      expect(
        planConversationUpdate(
          row({ status: "working" }),
          agent,
          ctx({ questionHold: "open" }),
        ),
      ).toEqual({
        kind: "patch",
        patch: { status: "waiting", waitingFor: "question" },
        adoptedSessionId: null,
      });
    }
    // Already showing the held question: nothing to write.
    expect(
      planConversationUpdate(
        row({ waitingFor: "question" }),
        live(),
        ctx({ questionHold: "open" }),
      ),
    ).toEqual({ kind: "noop" });
  });

  test("a held question resolving hands the status back to the agent", () => {
    expect(
      planConversationUpdate(
        row({ waitingFor: "question" }),
        live({ workingOn: "turn" }),
        ctx(),
      ),
    ).toMatchObject({
      kind: "patch",
      patch: { status: "working", waitingFor: null },
    });
  });

  test("a live session on a gone row resurrects it (endedAt cleared)", () => {
    expect(
      planConversationUpdate(row({ status: "gone" }), live(), ctx()),
    ).toMatchObject({
      kind: "patch",
      patch: { status: "waiting", endedAt: null },
    });
  });

  describe("the agent coming up delivers what was held for it", () => {
    test("out of starting", () => {
      expect(
        planConversationUpdate(row({ status: "starting" }), live(), ctx()),
      ).toMatchObject({ kind: "patch", agentCameUp: true });
    });

    test("out of gone — a spawn that outlived the starting sweep", () => {
      expect(
        planConversationUpdate(
          row({ status: "gone" }),
          live({ workingOn: "turn" }),
          ctx(),
        ),
      ).toMatchObject({
        kind: "patch",
        patch: { status: "working" },
        agentCameUp: true,
      });
    });

    test("not for an agent that was already up", () => {
      const plan = planConversationUpdate(
        row({ status: "waiting" }),
        live({ workingOn: "turn" }),
        ctx(),
      );
      expect(plan).toMatchObject({ kind: "patch" });
      expect(plan).not.toHaveProperty("agentCameUp");
    });
  });

  describe("session id gate", () => {
    test("a new id is a candidate only when it differs from the stored one", () => {
      expect(sessionCandidate(row(), live())).toBe(null);
      expect(sessionCandidate(row(), live({ claudeSessionId: null }))).toBe(
        null,
      );
      expect(
        sessionCandidate(row(), live({ claudeSessionId: NEW_SESSION })),
      ).toBe(NEW_SESSION);
      expect(sessionCandidate(row(), ABSENT)).toBe(null);
    });

    test("an accepted id is adopted and appended to the chain", () => {
      expect(
        planConversationUpdate(
          row(),
          live({ claudeSessionId: NEW_SESSION }),
          ctx({ sessionAccepted: true }),
        ),
      ).toMatchObject({
        kind: "patch",
        patch: { claudeSessionId: NEW_SESSION },
        adoptedSessionId: NEW_SESSION,
      });
    });

    test("a refused id keeps the stored one, silently", () => {
      expect(
        planConversationUpdate(
          row(),
          live({ claudeSessionId: NEW_SESSION }),
          ctx({ sessionAccepted: false }),
        ),
      ).toEqual({ kind: "noop" });
    });

    test("the first id (null → sid) flows through the same gate", () => {
      expect(
        planConversationUpdate(
          row({ claudeSessionId: null }),
          live({ claudeSessionId: NEW_SESSION }),
          ctx({ sessionAccepted: true }),
        ),
      ).toMatchObject({ adoptedSessionId: NEW_SESSION });
    });
  });
});

describe("planConversationUpdate — dead agent", () => {
  test("→ gone", () => {
    expect(planConversationUpdate(row(), live({ dead: true }), ctx())).toEqual({
      kind: "gone",
      stuckStartingMs: null,
    });
  });

  test("closeRequested → closed", () => {
    expect(
      planConversationUpdate(
        row({ closeRequested: true }),
        live({ dead: true }),
        ctx(),
      ),
    ).toEqual({ kind: "closed" });
  });

  test("already gone → noop", () => {
    expect(
      planConversationUpdate(
        row({ status: "gone" }),
        live({ dead: true }),
        ctx(),
      ),
    ).toEqual({ kind: "noop" });
  });
});

describe("planConversationUpdate — unknown state (unverified)", () => {
  const MARKED = new Date(NOW - 30_000);
  const MARK: UpdatePlan = {
    kind: "patch",
    patch: { statusUnverifiedSince: new Date(NOW) },
    adoptedSessionId: null,
  };
  const CLEAR: UpdatePlan = {
    kind: "patch",
    patch: { statusUnverifiedSince: null },
    adoptedSessionId: null,
  };

  test("unknown marks the row unverified — status untouched, whatever it is", () => {
    for (const r of [
      row(),
      row({ status: "working", workingOn: "turn" }),
      row({ status: "starting", createdAt: new Date(0) }),
    ]) {
      expect(planConversationUpdate(r, UNKNOWN, ctx())).toEqual(MARK);
    }
  });

  test("unknown keeps the first mark's time", () => {
    expect(
      planConversationUpdate(
        row({ statusUnverifiedSince: MARKED }),
        UNKNOWN,
        ctx(),
      ),
    ).toEqual({ kind: "noop" });
  });

  test("live clears the mark, alone or with the status change", () => {
    expect(
      planConversationUpdate(
        row({ statusUnverifiedSince: MARKED }),
        live(),
        ctx(),
      ),
    ).toEqual(CLEAR);
    expect(
      planConversationUpdate(
        row({ statusUnverifiedSince: MARKED }),
        live({ workingOn: "turn" }),
        ctx(),
      ),
    ).toEqual({
      kind: "patch",
      patch: {
        status: "working",
        workingOn: "turn",
        statusUnverifiedSince: null,
      },
      adoptedSessionId: null,
    });
  });

  test("absent clears the mark on every plan that keeps the row", () => {
    expect(
      planConversationUpdate(
        row({ status: "gone", statusUnverifiedSince: MARKED }),
        ABSENT,
        ctx(),
      ),
    ).toEqual(CLEAR);
    expect(
      planConversationUpdate(
        row({ statusUnverifiedSince: MARKED }),
        ABSENT,
        ctx(),
      ),
    ).toEqual({ kind: "hibernate", endTurn: false, clearUnverified: true });
    // gone / closed clear it in their own write.
    expect(
      planConversationUpdate(
        row({ closeRequested: true, statusUnverifiedSince: MARKED }),
        ABSENT,
        ctx(),
      ),
    ).toEqual({ kind: "closed" });
  });

  test("a checked row is never patched for the mark", () => {
    expect(planConversationUpdate(row(), live(), ctx())).toEqual({
      kind: "noop",
    });
  });
});

describe("planConversationUpdate — no live session", () => {
  test("already gone → noop", () => {
    expect(
      planConversationUpdate(row({ status: "gone" }), ABSENT, ctx()),
    ).toEqual({ kind: "noop" });
  });

  test("closeRequested → closed", () => {
    expect(
      planConversationUpdate(row({ closeRequested: true }), ABSENT, ctx()),
    ).toEqual({ kind: "closed" });
  });

  test("resumable → hibernate; already hibernated → left alone", () => {
    expect(planConversationUpdate(row(), ABSENT, ctx())).toEqual({
      kind: "hibernate",
      endTurn: false,
    });
    expect(
      planConversationUpdate(
        row({ hibernatedAt: new Date(NOW - 1000) }),
        ABSENT,
        ctx(),
      ),
    ).toEqual({ kind: "noop" });
  });

  test("a hibernation resume is left alone while its create runs inline, hibernated once it does not — whatever its age", () => {
    expect(
      planConversationUpdate(
        row({ resumingSince: new Date(NOW - 10 * 60_000) }),
        ABSENT,
        ctx({ inlineLaunchInFlight: true }),
      ),
    ).toEqual({ kind: "noop" });
    expect(
      planConversationUpdate(
        row({ resumingSince: new Date(NOW - 1000) }),
        ABSENT,
        ctx(),
      ),
    ).toEqual({ kind: "hibernate", endTurn: false });
  });

  test("a hibernation resume's live process ends the resume, its status untouched — never through starting", () => {
    expect(
      planConversationUpdate(
        row({ resumingSince: new Date(NOW - 1000) }),
        live(),
        ctx(),
      ),
    ).toEqual({
      kind: "patch",
      patch: { resumingSince: null },
      adoptedSessionId: null,
      agentCameUp: true,
    });
  });

  test("a live process clears a stale hibernation stamp — a relaunch that was not a resume ran under it", () => {
    expect(
      planConversationUpdate(
        row({
          status: "working",
          workingOn: "turn",
          hibernatedAt: new Date(NOW - 1000),
        }),
        live({ workingOn: "turn" }),
        ctx(),
      ),
    ).toEqual({
      kind: "patch",
      patch: { hibernatedAt: null },
      adoptedSessionId: null,
    });
  });

  test("a dead process keeps the stamp", () => {
    expect(
      planConversationUpdate(
        row({ status: "gone", hibernatedAt: new Date(NOW - 1000) }),
        live({ dead: true }),
        ctx(),
      ),
    ).toEqual({ kind: "noop" });
  });

  test("a mid-work resumable row hibernates and settles to waiting — nothing computes without a process", () => {
    expect(
      planConversationUpdate(row({ status: "working" }), ABSENT, ctx()),
    ).toEqual({ kind: "hibernate", endTurn: true });
  });

  test("an already-hibernated row still saying working is settled, not re-stamped", () => {
    expect(
      planConversationUpdate(
        row({ status: "working", hibernatedAt: new Date(NOW - 1000) }),
        ABSENT,
        ctx(),
      ),
    ).toEqual({
      kind: "patch",
      patch: { status: "waiting", waitingFor: null },
      adoptedSessionId: null,
    });
  });

  // A forked database's rows from before its fork point are copies of the
  // source's: their agents run elsewhere, so they are never settled here.
  test("a row the fork copied in is not this backend's to settle", () => {
    expect(
      planConversationUpdate(
        row({ status: "working" }),
        ABSENT,
        ctx({ forkedAt: new Date(NOW - 1000) }),
      ),
    ).toEqual({ kind: "noop" });
  });

  // The row a worktree backend launched itself, after its database's fork:
  // its own, reconciled like any of main's (it stayed `waiting`, never
  // hibernated, and its next turn failed with no agent to resume).
  test("a row created after the fork point is this backend's own", () => {
    const forkedAt = new Date(NOW - 2 * 60 * 60_000);
    expect(
      planConversationUpdate(
        row({ status: "waiting" }),
        ABSENT,
        ctx({ forkedAt }),
      ),
    ).toEqual({ kind: "hibernate", endTurn: false });
    expect(
      planConversationUpdate(
        row({ status: "working" }),
        ABSENT,
        ctx({ forkedAt }),
      ),
    ).toEqual({ kind: "hibernate", endTurn: true });
  });

  test("nothing to resume → gone", () => {
    expect(
      planConversationUpdate(row({ claudeSessionId: null }), ABSENT, ctx()),
    ).toEqual({ kind: "gone", stuckStartingMs: null });
  });

  test("a row the fork copied in → never a write", () => {
    expect(
      planConversationUpdate(
        row({ claudeSessionId: null }),
        ABSENT,
        ctx({ forkedAt: new Date(NOW - 1000) }),
      ),
    ).toEqual({ kind: "noop" });
  });

  describe("a starting row is decided by whether its launch is still coming, never by its age", () => {
    const startedAgo = (ms: number) =>
      row({
        status: "starting",
        claudeSessionId: null,
        createdAt: new Date(NOW - ms),
      });

    test("an inline create still running → noop, however old", () => {
      expect(
        planConversationUpdate(
          startedAgo(10 * 60_000),
          ABSENT,
          ctx({ inlineLaunchInFlight: true }),
        ),
      ).toEqual({ kind: "noop" });
    });

    test("nothing coming, however young → gone, flagged as never started", () => {
      expect(planConversationUpdate(startedAgo(1000), ABSENT, ctx())).toEqual({
        kind: "gone",
        stuckStartingMs: 1000,
      });
    });

    test("past it, nothing to resume → gone, flagged as stuck", () => {
      expect(planConversationUpdate(startedAgo(45_000), ABSENT, ctx())).toEqual(
        { kind: "gone", stuckStartingMs: 45_000 },
      );
    });

    test("past it, with a session (a resume whose agent died) → hibernate, not a crash", () => {
      expect(
        planConversationUpdate(
          row({ status: "starting", createdAt: new Date(NOW - 45_000) }),
          ABSENT,
          ctx(),
        ),
      ).toEqual({ kind: "hibernate", endTurn: false });
    });

    test("past it, its spawn job still coming (a retry after a restart) → noop, never gone", () => {
      expect(
        planConversationUpdate(
          startedAgo(10 * 60_000),
          ABSENT,
          ctx({ spawnInFlight: true }),
        ),
      ).toEqual({ kind: "noop" });
    });

    test("its spawn job still coming, closeRequested → closed", () => {
      expect(
        planConversationUpdate(
          row({ status: "starting", closeRequested: true }),
          ABSENT,
          ctx({ spawnInFlight: true }),
        ),
      ).toEqual({ kind: "closed" });
    });

    test("past it, closeRequested → closed", () => {
      expect(
        planConversationUpdate(
          row({
            status: "starting",
            closeRequested: true,
            createdAt: new Date(NOW - 45_000),
          }),
          ABSENT,
          ctx(),
        ),
      ).toEqual({ kind: "closed" });
    });
  });
});

describe("liveStatusFor — a confirmed submit is evidence of work", () => {
  const SUBMIT = new Date(NOW);
  const info = (o: Partial<RuntimeInfo>): RuntimeInfo =>
    (live(o) as Extract<Liveness, { kind: "live" }>).info;

  test("an idle written before the submit is stale: working", () => {
    expect(
      liveStatusFor(
        info({ statusWrittenAt: new Date(NOW - 50) }),
        SUBMIT,
        null,
        NOW,
      ),
    ).toEqual({ status: "working", workingOn: "turn" });
  });

  test("an idle written after the submit (turn ended, interrupted) stands", () => {
    // The 2026-10-18 rewind: submitted 15:53:10, idle 15:53:22, hook drained
    // 15:54:48 — still waiting.
    expect(
      liveStatusFor(
        info({ statusWrittenAt: new Date(NOW + 12_000) }),
        SUBMIT,
        null,
        NOW,
      ),
    ).toEqual({ status: "waiting" });
  });

  test("no status write to weigh (a dead agent, no event yet) — the submit overrides nothing", () => {
    expect(
      liveStatusFor(info({ statusWrittenAt: null }), SUBMIT, null, NOW),
    ).toEqual({
      status: "waiting",
    });
  });

  test("the planner writes it on a waiting row", () => {
    const plan = planConversationUpdate(
      row(),
      live({ statusWrittenAt: new Date(NOW - 50) }),
      ctx({ lastSubmitAt: SUBMIT }),
    );
    expect(plan.kind === "patch" && plan.patch.status).toBe("working");
  });
});

describe("liveStatusFor — a pending turn is work the agent will start on its own", () => {
  test("an idle agent holding its launch prompt (CLI still booting) is working", () => {
    // conv-1793370919-vpts6t, 2026-10-30: `started` at 14:35:25, launch turn
    // typed, its turn_started at 14:35:29 — the row read `waiting` between and
    // a watch went quiet on it.
    const plan = planConversationUpdate(
      row({ status: "starting", claudeSessionId: null }),
      live({ claudeSessionId: null, statusWrittenAt: new Date(NOW) }),
      ctx({ pendingTurnSince: new Date(NOW) }),
    );
    expect(plan).toMatchObject({
      kind: "patch",
      patch: { status: "working", workingOn: "turn" },
    });
  });

  test("a turn ending with another queued behind it stays working", () => {
    expect(
      planConversationUpdate(
        row({ status: "working", workingOn: "turn" }),
        live({ statusWrittenAt: new Date(NOW) }),
        ctx({ pendingTurnSince: new Date(NOW) }),
      ),
    ).toEqual({ kind: "noop" });
  });

  test("nothing pending: the idle stands", () => {
    expect(
      planConversationUpdate(
        row({ status: "working", workingOn: "turn" }),
        live({ statusWrittenAt: new Date(NOW) }),
        ctx({ pendingTurnSince: null }),
      ),
    ).toMatchObject({ kind: "patch", patch: { status: "waiting" } });
  });

  test("a held question still wins: the agent is blocked on it", () => {
    expect(
      planConversationUpdate(
        row({ status: "working", workingOn: "turn" }),
        live({ workingOn: "turn" }),
        ctx({ pendingTurnSince: new Date(NOW), questionHold: "open" }),
      ),
    ).toMatchObject({
      kind: "patch",
      patch: { status: "waiting", waitingFor: "question" },
    });
  });
});

describe("liveStatusFor — a turn an idle agent never starts makes it stuck", () => {
  const info = (o: Partial<RuntimeInfo>): RuntimeInfo =>
    (live(o) as Extract<Liveness, { kind: "live" }>).info;
  const REST = new Date(NOW - STUCK_TURN_MS);

  test("at rest with it for the bound: stuck, since the later of the two", () => {
    expect(
      liveStatusFor(
        info({ statusWrittenAt: REST }),
        null,
        new Date(NOW - 2 * STUCK_TURN_MS),
        NOW,
      ),
    ).toEqual({ status: "stuck", since: REST });
  });

  test("just short of the bound: still working", () => {
    expect(
      liveStatusFor(
        info({ statusWrittenAt: new Date(REST.getTime() + 1) }),
        null,
        REST,
        NOW,
      ),
    ).toEqual({ status: "working", workingOn: "turn" });
  });

  test("a turn queued for an hour behind a long turn starts its clock when that turn ends", () => {
    expect(
      liveStatusFor(
        info({ statusWrittenAt: new Date(NOW - 1_000) }),
        null,
        new Date(NOW - 3_600_000),
        NOW,
      ),
    ).toEqual({ status: "working", workingOn: "turn" });
  });

  test("a running turn or background work is busy whatever the pending turn's age", () => {
    expect(
      liveStatusFor(
        info({ workingOn: "turn", statusWrittenAt: REST }),
        null,
        REST,
        NOW,
      ),
    ).toEqual({ status: "working", workingOn: "turn" });
    expect(
      liveStatusFor(
        info({ workingOn: "background", statusWrittenAt: REST }),
        null,
        REST,
        NOW,
      ),
    ).toEqual({ status: "working", workingOn: "background" });
  });

  test("the planner writes it as waiting on a stuck turn, and says so once", () => {
    const plan = planConversationUpdate(
      row({ status: "working", workingOn: "turn" }),
      live({ statusWrittenAt: REST }),
      ctx({ pendingTurnSince: REST }),
    );
    expect(plan).toEqual({
      kind: "patch",
      patch: {
        status: "waiting",
        waitingFor: STUCK_TURN_WAITING_FOR,
      },
      adoptedSessionId: null,
      stuckSince: REST,
    });
    expect(
      planConversationUpdate(
        row({ status: "waiting", waitingFor: STUCK_TURN_WAITING_FOR }),
        live({ statusWrittenAt: REST }),
        ctx({ pendingTurnSince: REST }),
      ),
    ).toEqual({ kind: "noop" });
  });

  test("the turn starting at last ends it", () => {
    expect(
      planConversationUpdate(
        row({ status: "waiting", waitingFor: STUCK_TURN_WAITING_FOR }),
        live({ workingOn: "turn", statusWrittenAt: new Date(NOW) }),
        ctx({ pendingTurnSince: null }),
      ),
    ).toEqual({
      kind: "patch",
      patch: { status: "working", workingOn: "turn", waitingFor: null },
      adoptedSessionId: null,
    });
  });

  test("the turn failing or dropped ends it: idle", () => {
    expect(
      planConversationUpdate(
        row({ status: "waiting", waitingFor: STUCK_TURN_WAITING_FOR }),
        live({ statusWrittenAt: REST }),
        ctx({ pendingTurnSince: null }),
      ),
    ).toEqual({
      kind: "patch",
      patch: { waitingFor: null },
      adoptedSessionId: null,
    });
  });

  test("its process gone: the stuck mark settles with the hibernation", () => {
    const stuck = row({
      status: "waiting",
      waitingFor: STUCK_TURN_WAITING_FOR,
    });
    expect(planConversationUpdate(stuck, ABSENT, ctx())).toEqual({
      kind: "hibernate",
      endTurn: true,
    });
    expect(
      planConversationUpdate(
        { ...stuck, hibernatedAt: new Date(NOW - 1_000) },
        ABSENT,
        ctx(),
      ),
    ).toMatchObject({ kind: "patch", patch: { waitingFor: null } });
  });
});
