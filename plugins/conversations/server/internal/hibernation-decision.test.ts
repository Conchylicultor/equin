import { describe, expect, test } from "bun:test";
import { decideMissingProcessAction } from "./hibernation-decision";

const SESSION = "a4ee9684-418d-4661-b372-2960760538a7";
const CREATED = new Date("2026-10-02T12:00:00Z");
// A database never forked owns every row.
const unforked = { forkedAt: null };

describe("decideMissingProcessAction", () => {
  test("resumable + not yet hibernated → hibernate", () => {
    expect(
      decideMissingProcessAction(
        { claudeSessionId: SESSION, hibernatedAt: null, createdAt: CREATED },
        unforked,
      ),
    ).toBe("hibernate");
  });

  // An already-hibernated row's process is intentionally absent forever. It must
  // be left alone, never flipped to gone on the next reconcile.
  test("already hibernated → leave-hibernated (NOT gone)", () => {
    expect(
      decideMissingProcessAction(
        {
          claudeSessionId: SESSION,
          hibernatedAt: new Date(0),
          createdAt: CREATED,
        },
        unforked,
      ),
    ).toBe("leave-hibernated");
  });

  // The one honest `gone`: no session id means no transcript to resume from.
  test("no resumable session → gone", () => {
    expect(
      decideMissingProcessAction(
        { claudeSessionId: null, hibernatedAt: null, createdAt: CREATED },
        unforked,
      ),
    ).toBe("gone");
  });

  test("a row the fork copied in → leave-unowned, never a status write", () => {
    expect(
      decideMissingProcessAction(
        { claudeSessionId: SESSION, hibernatedAt: null, createdAt: CREATED },
        { forkedAt: new Date(CREATED.getTime() + 1) },
      ),
    ).toBe("leave-unowned");
  });

  test("a row created after the fork point is this database's own", () => {
    expect(
      decideMissingProcessAction(
        { claudeSessionId: SESSION, hibernatedAt: null, createdAt: CREATED },
        { forkedAt: new Date(CREATED.getTime() - 1) },
      ),
    ).toBe("hibernate");
  });

  // Regressions for the bug that reaped live conversations' worktrees: a missing
  // pane must never move status, so the ONLY input that can produce `gone` is an
  // absent claudeSessionId. Conversation status is not even readable here — the
  // signature omits it — so these assert the property at its two live inputs.
  describe("a missing pane never depends on conversation status", () => {
    // Previously `status !== "waiting"` fell through to `gone`, so a reboot or
    // `tmux kill-server` mid-turn marked a working conversation gone, which made
    // `attempts_v.active` false and its git worktree collectable by the reaper.
    test("mid-work rows hibernate like any other resumable row", () => {
      expect(
        decideMissingProcessAction(
          { claudeSessionId: SESSION, hibernatedAt: null, createdAt: CREATED },
          unforked,
        ),
      ).toBe("hibernate");
    });

    // A resume whose pane never came up keeps its session id, so it hibernates
    // and stays openable instead of being swept to gone by the starting timeout.
    test("a failed resume still holding its session id hibernates", () => {
      expect(
        decideMissingProcessAction(
          { claudeSessionId: SESSION, hibernatedAt: null, createdAt: CREATED },
          unforked,
        ),
      ).toBe("hibernate");
    });
  });

  // `hibernationConfig.enabled` gates the proactive idle-kill job only. Turning
  // it off must not convert "reclaim resources" into "lose the conversation", so
  // it is absent from this decision entirely.
  test("the hibernation config cannot influence the decision", () => {
    const decide = decideMissingProcessAction as unknown as (
      row: {
        claudeSessionId: string | null;
        hibernatedAt: Date | null;
        createdAt: Date;
      },
      opts: { forkedAt: Date | null; hibernationEnabled?: boolean },
    ) => string;
    const row = {
      claudeSessionId: SESSION,
      hibernatedAt: null,
      createdAt: CREATED,
    };
    expect(decide(row, { forkedAt: null, hibernationEnabled: false })).toBe(
      "hibernate",
    );
    expect(decide(row, { forkedAt: null, hibernationEnabled: true })).toBe(
      "hibernate",
    );
  });
});
