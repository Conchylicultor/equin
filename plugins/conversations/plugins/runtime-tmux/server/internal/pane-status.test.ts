import { describe, expect, test } from "bun:test";
import type { SessionState } from "./claude-session";
import { resolvePaneStatus } from "./pane-status";

// Titles as the CLI actually renders them, captured from live panes:
//   READY   — the `✳` mark. Rendered when idle on every version, AND throughout
//             a working turn on ≥ 2.1.236, which stopped animating the title.
//   SPINNER — one animation frame (half-circles on 2.1.228…2.1.235).
//   BARE    — no status prefix at all (startup, before the CLI paints one).
const READY = "✳ Fix the login bug";
const SPINNER = "◐ Fix the login bug";
const BARE = "Fix the login bug";

const session = (
  status: SessionState["status"],
  waitingFor: string | null = null,
): SessionState => ({
  sessionId: "s1",
  status,
  waitingFor,
  statusUpdatedAt: null,
});

const working = (
  title: string,
  status: SessionState["status"],
  { opActive = false, waitingFor = null as string | null } = {},
): boolean =>
  resolvePaneStatus(title, session(status, waitingFor), opActive).working;

describe("the session file is the authority", () => {
  // The regression this module was extracted for: CLI ≥ 2.1.236 renders the
  // ready mark for the whole turn, so a title-first rule reported every working
  // agent as waiting while the file said "busy" all along.
  test("busy + ready-mark title reads as working", () => {
    expect(working(READY, "busy")).toBe(true);
  });

  test("busy is working whatever the title says", () => {
    expect(working(SPINNER, "busy")).toBe(true);
    expect(working(BARE, "busy")).toBe(true);
  });

  test("idle and waiting are not working", () => {
    expect(working(READY, "idle")).toBe(false);
    expect(working(BARE, "idle")).toBe(false);
    expect(working(READY, "waiting")).toBe(false);
  });
});

describe("the title may promote, never demote", () => {
  // The file lags the TUI by one write at a turn boundary; a spinning title is
  // proof of work the file has not recorded yet.
  test("a spinner promotes a not-yet-updated idle file to working", () => {
    expect(working(SPINNER, "idle")).toBe(true);
  });

  test("a ready mark cannot demote a busy file", () => {
    expect(working(READY, "busy")).toBe(true);
  });

  test("an unrecognised spinner glyph is cosmetic, not a status blackout", () => {
    // The whole point of the promote-only rule: a frame from some future CLI
    // version we don't know about costs a hint, never a wrong verdict.
    expect(working("✻ Fix the login bug", "busy")).toBe(true);
    expect(working("✻ Fix the login bug", "idle")).toBe(false);
  });
});

describe("the ambiguous `shell` status", () => {
  // See research/2026-06-03-global-fix-shell-status-stuck-working.md: "shell"
  // is written both for a build/push that will resume the agent and for a
  // never-ending background shell it will wait on forever. Only our own
  // op marker separates them.
  test("a build/push in flight reads as working", () => {
    expect(working(READY, "shell", { opActive: true })).toBe(true);
  });

  test("a never-ending background shell reads as waiting, not stuck working", () => {
    expect(working(READY, "shell")).toBe(false);
    expect(working(BARE, "shell")).toBe(false);
  });

  test("a spinning title still promotes a shell pane (older CLIs)", () => {
    expect(working(SPINNER, "shell")).toBe(true);
  });
});

describe("no session file", () => {
  // Startup race, or a CLI too old to write one. The title is all there is, so
  // it decides in both directions.
  test("a ready mark is the only thing that means waiting", () => {
    expect(working(READY, null)).toBe(false);
    expect(working(SPINNER, null)).toBe(true);
    expect(working(BARE, null)).toBe(true);
  });
});

describe("waitingFor", () => {
  test("surfaces the file's reason when not working", () => {
    expect(
      resolvePaneStatus(READY, session("waiting", "permission prompt"), false),
    ).toMatchObject({ working: false, waitingFor: "permission prompt" });
  });

  test("is suppressed while working — a stale reason must not leak", () => {
    expect(
      resolvePaneStatus(READY, session("busy", "permission prompt"), false),
    ).toMatchObject({ working: true, waitingFor: null });
  });
});

describe("display title", () => {
  test("strips the status prefix", () => {
    expect(resolvePaneStatus(SPINNER, session("busy"), false).title).toBe(
      "Fix the login bug",
    );
    expect(resolvePaneStatus(READY, session("idle"), false).title).toBe(
      "Fix the login bug",
    );
  });

  test("blanks the uninformative defaults (bare hostname, session name)", () => {
    expect(resolvePaneStatus("✳ mbp.local", session("idle"), false).title).toBe(
      "",
    );
    expect(
      resolvePaneStatus("✳ conv-1787216249-f59z", session("idle"), false).title,
    ).toBe("");
    expect(resolvePaneStatus("_ ✳ ", session("idle"), false).title).toBe("");
  });
});
