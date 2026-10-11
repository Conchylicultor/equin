import { describe, expect, test } from "bun:test";
import {
  planConversationUpdate,
  sessionCandidate,
  STARTING_TIMEOUT_MS,
  type Liveness,
  type PlanContext,
  type PlanRow,
} from "./plan-update";
import type { RuntimeInfo } from "./runtime";
import type { TerminalMenu } from "@plugins/conversations/plugins/terminal-menu/core";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const SESSION = "a4ee9684-418d-4661-b372-2960760538a7";
const NEW_SESSION = "0b1c2d3e-0000-4000-8000-000000000001";

function row(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    status: "waiting",
    closeRequested: false,
    title: "Fix the thing",
    claudeSessionId: SESSION,
    waitingFor: null,
    waitingMenu: null,
    createdAt: new Date(NOW - 60 * 60_000),
    hibernatedAt: null,
    ...overrides,
  };
}

function live(overrides: Partial<RuntimeInfo> = {}): Liveness {
  return {
    kind: "live",
    info: {
      title: "Fix the thing",
      working: false,
      dead: false,
      claudeSessionId: SESSION,
      worktreePath: "/wt",
      waitingFor: null,
      menu: null,
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
    ...overrides,
  };
}

describe("planConversationUpdate — orphans (no row in any status)", () => {
  test("a live session is adopted on main, with its status and title", () => {
    expect(
      planConversationUpdate(null, live({ working: true, title: "T" }), ctx()),
    ).toEqual({ kind: "adopt", status: "working", title: "T" });
  });

  test("never adopted off main — every worktree sees every tmux session", () => {
    expect(
      planConversationUpdate(null, live(), ctx({ onMain: false })),
    ).toEqual({ kind: "noop" });
  });

  test("a dead pane, a pane with no worktree, or no session is not adopted", () => {
    expect(planConversationUpdate(null, live({ dead: true }), ctx())).toEqual({
      kind: "noop",
    });
    expect(
      planConversationUpdate(null, live({ worktreePath: "" }), ctx()),
    ).toEqual({ kind: "noop" });
    expect(planConversationUpdate(null, ABSENT, ctx())).toEqual({
      kind: "noop",
    });
  });

  test("an empty pane title adopts as no title", () => {
    expect(planConversationUpdate(null, live({ title: "" }), ctx())).toEqual({
      kind: "adopt",
      status: "waiting",
      title: null,
    });
  });
});

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

  test("working → waiting carries waitingFor", () => {
    expect(
      planConversationUpdate(
        row({ status: "working" }),
        live({ waitingFor: "permission prompt" }),
        ctx(),
      ),
    ).toEqual({
      kind: "patch",
      patch: { status: "waiting", waitingFor: "permission prompt" },
      adoptedSessionId: null,
      taskTitle: null,
      menuOpened: false,
    });
  });

  test("working clears a stale waitingFor", () => {
    expect(
      planConversationUpdate(
        row({ waitingFor: "question" }),
        live({ working: true, waitingFor: "question" }),
        ctx(),
      ),
    ).toMatchObject({
      kind: "patch",
      patch: { status: "working", waitingFor: null },
      menuOpened: false,
    });
  });

  test("the question override opens a question exactly on the transition", () => {
    expect(
      planConversationUpdate(row(), live({ waitingFor: "question" }), ctx()),
    ).toMatchObject({
      kind: "patch",
      patch: { waitingFor: "question" },
      menuOpened: true,
    });
    // Already open: nothing to write, nothing to re-open.
    expect(
      planConversationUpdate(
        row({ waitingFor: "question" }),
        live({ waitingFor: "question" }),
        ctx(),
      ),
    ).toEqual({ kind: "noop" });
  });

  test("a held question waits on a question with no menu — and never flushes", () => {
    // The relay holds the call: no menu, so the pane reads idle (or busy).
    for (const pane of [live(), live({ working: true })]) {
      expect(
        planConversationUpdate(
          row({ status: "working" }),
          pane,
          ctx({ questionHold: "open" }),
        ),
      ).toEqual({
        kind: "patch",
        patch: { status: "waiting", waitingFor: "question" },
        adoptedSessionId: null,
        taskTitle: null,
        menuOpened: false,
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

  test("a held question resolving hands the status back to the pane", () => {
    expect(
      planConversationUpdate(
        row({ waitingFor: "question" }),
        live({ working: true }),
        ctx(),
      ),
    ).toMatchObject({
      kind: "patch",
      patch: { status: "working", waitingFor: null },
      menuOpened: false,
    });
  });

  test("the menu of a released question is shown, never auto-flushed", () => {
    // The user picked "Answer in terminal": the menu that opens is the one
    // they asked for, so auto-open must leave it alone.
    expect(
      planConversationUpdate(
        row(),
        live({ waitingFor: "question" }),
        ctx({ questionHold: "released" }),
      ),
    ).toMatchObject({
      kind: "patch",
      patch: { waitingFor: "question" },
      menuOpened: false,
    });
    // Released and the menu not drawn yet: the pane decides (nothing waits).
    expect(
      planConversationUpdate(
        row({ waitingFor: "question" }),
        live(),
        ctx({ questionHold: "released" }),
      ),
    ).toMatchObject({ kind: "patch", patch: { waitingFor: null } });
  });

  test("only the pane's own menu opening triggers the flush", () => {
    expect(
      planConversationUpdate(
        row({ status: "working" }),
        live({ waitingFor: "question" }),
        ctx(),
      ),
    ).toMatchObject({ kind: "patch", menuOpened: true });
    // A menu while a held question is still open (cannot normally happen —
    // the hold suppresses it): the hold wins, nothing flushes.
    expect(
      planConversationUpdate(
        row({ status: "working" }),
        live({ waitingFor: "question" }),
        ctx({ questionHold: "open" }),
      ),
    ).toMatchObject({ kind: "patch", menuOpened: false });
  });

  test("an informative title is written and carried onto the task", () => {
    expect(
      planConversationUpdate(row(), live({ title: "Better title" }), ctx()),
    ).toMatchObject({
      kind: "patch",
      patch: { title: "Better title" },
      taskTitle: "Better title",
    });
  });

  test.each(["Claude Code", "Untitled", "Untitled conversation", ""])(
    "an uninformative title (%p) never overwrites the stored one",
    (title) => {
      expect(planConversationUpdate(row(), live({ title }), ctx())).toEqual({
        kind: "noop",
      });
    },
  );

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

describe("planConversationUpdate — dead pane", () => {
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
      taskTitle: null,
      menuOpened: false,
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

    test("past it, with a session (a resume whose pane died) → hibernate, not a crash", () => {
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

describe("planConversationUpdate — a terminal menu on screen", () => {
  const MENU: TerminalMenu = {
    title: "What do you want to do?",
    body: "",
    options: [
      { n: 1, label: "Stop and wait for limit to reset", description: null },
      { n: 2, label: "Switch to usage credits", description: null },
    ],
    highlighted: 1,
    footer: "Enter to confirm · Esc to cancel",
  };

  test("records the menu and waits on it, over the CLI's own reason", () => {
    expect(
      planConversationUpdate(
        row({ status: "working" }),
        live({ waitingFor: "input needed", menu: MENU }),
        ctx(),
      ),
    ).toMatchObject({
      kind: "patch",
      patch: { status: "waiting", waitingFor: "menu", waitingMenu: MENU },
      menuOpened: false,
    });
  });

  test("the same menu again is a noop", () => {
    expect(
      planConversationUpdate(
        row({ waitingFor: "menu", waitingMenu: MENU }),
        live({
          menu: { ...MENU, options: MENU.options.map((o) => ({ ...o })) },
        }),
        ctx(),
      ),
    ).toEqual({ kind: "noop" });
  });

  test("a moved highlight updates the menu alone", () => {
    expect(
      planConversationUpdate(
        row({ waitingFor: "menu", waitingMenu: MENU }),
        live({ menu: { ...MENU, highlighted: 2 } }),
        ctx(),
      ),
    ).toMatchObject({
      kind: "patch",
      patch: { waitingMenu: { ...MENU, highlighted: 2 } },
    });
  });

  test("a menu that left the screen clears both", () => {
    expect(
      planConversationUpdate(
        row({ waitingFor: "menu", waitingMenu: MENU }),
        live({ working: true }),
        ctx(),
      ),
    ).toMatchObject({
      kind: "patch",
      patch: { status: "working", waitingFor: null, waitingMenu: null },
    });
  });

  test("a held question wins over a menu", () => {
    expect(
      planConversationUpdate(
        row(),
        live({ menu: MENU }),
        ctx({ questionHold: "open" }),
      ),
    ).toMatchObject({
      kind: "patch",
      patch: { waitingFor: "question" },
    });
  });
});
