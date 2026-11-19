import { describe, expect, it } from "bun:test";
import {
  laterWrite,
  REMINDER_CADENCE_MS,
  reminderDecision,
  type ReminderInputs,
} from "./reminder";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-17T05:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

const inputs = (over: Partial<ReminderInputs> = {}): ReminderInputs => ({
  settings: { enabled: true, snoozedUntil: new Date(0), skippedRelease: "" },
  latest: "v2026.11.14",
  taskLive: false,
  lastRemindedAt: null,
  now,
  ...over,
});
const settings = (over: Partial<ReminderInputs["settings"]>) => ({
  ...inputs().settings,
  ...over,
});

describe("reminderDecision", () => {
  it("reminds of a release never brought up", () => {
    expect(reminderDecision(inputs()).kind).toBe("remind");
  });

  it("stays quiet when reminders are off, the release skipped, or an update is under way", () => {
    expect(
      reminderDecision(inputs({ settings: settings({ enabled: false }) })),
    ).toEqual({ kind: "quiet", reason: "disabled" });
    expect(
      reminderDecision(
        inputs({ settings: settings({ skippedRelease: "v2026.11.14" }) }),
      ),
    ).toEqual({ kind: "quiet", reason: "skipped" });
    expect(reminderDecision(inputs({ taskLive: true }))).toEqual({
      kind: "quiet",
      reason: "task-live",
    });
  });

  it("a skipped release does not silence a newer one", () => {
    expect(
      reminderDecision(
        inputs({
          latest: "v2026.11.20",
          settings: settings({ skippedRelease: "v2026.11.14" }),
        }),
      ).kind,
    ).toBe("remind");
  });

  it("reminds again at most every two weeks", () => {
    expect(reminderDecision(inputs({ lastRemindedAt: ago(DAY) }))).toEqual({
      kind: "quiet",
      reason: "reminded",
    });
    expect(
      reminderDecision(inputs({ lastRemindedAt: ago(REMINDER_CADENCE_MS) }))
        .kind,
    ).toBe("remind");
  });

  it("a newer release does not restart the cadence", () => {
    // The last reminder was about an older release, a day ago.
    expect(
      reminderDecision(
        inputs({ latest: "v2026.11.20", lastRemindedAt: ago(DAY) }),
      ),
    ).toEqual({ kind: "quiet", reason: "reminded" });
    expect(
      reminderDecision(
        inputs({ latest: "v2026.11.20", lastRemindedAt: ago(14 * DAY) }),
      ).kind,
    ).toBe("remind");
  });

  it("a snooze holds until its time, then replaces the cadence", () => {
    const lastRemindedAt = ago(DAY);
    expect(
      reminderDecision(
        inputs({
          lastRemindedAt,
          settings: settings({ snoozedUntil: new Date(now.getTime() + 1) }),
        }),
      ),
    ).toEqual({ kind: "quiet", reason: "snoozed" });
    // Snoozed "tomorrow" right after the reminder: due now, a day later.
    expect(
      reminderDecision(
        inputs({
          lastRemindedAt,
          settings: settings({ snoozedUntil: now }),
        }),
      ).kind,
    ).toBe("remind");
  });
});

describe("laterWrite", () => {
  it("snoozes to the start of the UTC day it lands on — that day's check", () => {
    const afternoon = new Date("2026-11-17T14:30:00Z");
    expect(laterWrite("tomorrow", "v1", afternoon)).toEqual({
      key: "snoozedUntil",
      value: new Date("2026-11-18T00:00:00Z"),
    });
    expect(laterWrite("week", "v1", afternoon)).toEqual({
      key: "snoozedUntil",
      value: new Date("2026-11-24T00:00:00Z"),
    });
    expect(laterWrite("month", "v1", afternoon)).toEqual({
      key: "snoozedUntil",
      value: new Date(new Date("2026-11-17T00:00:00Z").getTime() + 30 * DAY),
    });
    // Tomorrow's 05:00 UTC check is past the snooze.
    expect(
      reminderDecision(
        inputs({
          now: new Date("2026-11-18T05:00:00Z"),
          lastRemindedAt: new Date("2026-11-17T05:00:00Z"),
          settings: settings({
            snoozedUntil: new Date("2026-11-18T00:00:00Z"),
          }),
        }),
      ).kind,
    ).toBe("remind");
  });

  it("writes the one setting each other choice means", () => {
    expect(laterWrite("skip", "v1", now)).toEqual({
      key: "skippedRelease",
      value: "v1",
    });
    expect(laterWrite("never", "v1", now)).toEqual({
      key: "enabled",
      value: false,
    });
  });
});
