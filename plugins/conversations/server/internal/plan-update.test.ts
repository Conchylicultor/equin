import { describe, expect, test } from "bun:test";
import {
  liveStatusFor,
  planConversationUpdate,
  sessionCandidate,
  STARTING_TIMEOUT_MS,
  type Liveness,
  type PlanContext,
  type PlanRow,
} from "./plan-update";
import type { RuntimeInfo } from "./runtime";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const SESSION = "a4ee9684-418d-4661-b372-2960760538a7";
const NEW_SESSION = "0b1c2d3e-0000-4000-8000-000000000001";

function row(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    status: "waiting",
    closeRequested: false,
    claudeSessionId: SESSION,
    waitingFor: null,
    createdAt: new Date(NOW - 60 * 60_000),
    hibernatedAt: null,
    ...overrides,
  };
}

function live(overrides: Partial<RuntimeInfo> = {}): Liveness {
  return {
    kind: "live",
    info: {
      working: false,
      dead: false,
      claudeSessionId: SESSION,
      statusWrittenAt: null,
      ...overrides,
    },
  };
}

const ABSENT: Liveness = { kind: "absent" };
const UNKNOWN: Liveness = { kind: "unknown" };

function ctx(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    onMain: true,
    now: NOW,
    sessionAccepted: false,
    questionHold: null,
    lastSubmitAt: null,
    ...overrides,
  };
}

describe("planConversationUpdate — done is never overwritten", () => {
  test.each([
    ["live", live({ working: true })],
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
      planConversationUpdate(row(), live({ working: true }), ctx()),
    ).toMatchObject({ kind: "patch", patch: { status: "working" } });
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
    for (const agent of [live(), live({ working: true })]) {
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
        live({ working: true }),
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

describe("planConversationUpdate — no live session", () => {
  test("failed runtime (unknown) → untouched, whatever the row", () => {
    expect(planConversationUpdate(row(), UNKNOWN, ctx())).toEqual({
      kind: "noop",
    });
    expect(
      planConversationUpdate(
        row({ status: "starting", createdAt: new Date(0) }),
        UNKNOWN,
        ctx(),
      ),
    ).toEqual({ kind: "noop" });
  });

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

  test("off main, a working row is not this backend's to settle", () => {
    expect(
      planConversationUpdate(
        row({ status: "working" }),
        ABSENT,
        ctx({ onMain: false }),
      ),
    ).toEqual({ kind: "noop" });
  });

  test("nothing to resume → gone", () => {
    expect(
      planConversationUpdate(row({ claudeSessionId: null }), ABSENT, ctx()),
    ).toEqual({ kind: "gone", stuckStartingMs: null });
  });

  test("off main → never a write", () => {
    expect(
      planConversationUpdate(
        row({ claudeSessionId: null }),
        ABSENT,
        ctx({ onMain: false }),
      ),
    ).toEqual({ kind: "noop" });
  });

  describe("starting grace", () => {
    const startedAgo = (ms: number) =>
      row({
        status: "starting",
        claudeSessionId: null,
        createdAt: new Date(NOW - ms),
      });

    test("inside the window → noop", () => {
      expect(
        planConversationUpdate(
          startedAgo(STARTING_TIMEOUT_MS - 1),
          ABSENT,
          ctx(),
        ),
      ).toEqual({ kind: "noop" });
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
      liveStatusFor(info({ statusWrittenAt: new Date(NOW - 50) }), SUBMIT),
    ).toBe("working");
  });

  test("an idle written after the submit (turn ended, interrupted) stands", () => {
    // The 2026-10-18 rewind: submitted 15:53:10, idle 15:53:22, hook drained
    // 15:54:48 — still waiting.
    expect(
      liveStatusFor(info({ statusWrittenAt: new Date(NOW + 12_000) }), SUBMIT),
    ).toBe("waiting");
  });

  test("no status write to weigh (a dead agent, no event yet) — the submit overrides nothing", () => {
    expect(liveStatusFor(info({ statusWrittenAt: null }), SUBMIT)).toBe(
      "waiting",
    );
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
