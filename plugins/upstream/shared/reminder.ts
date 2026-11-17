import { z } from "zod";

/** How often an unanswered release is brought up again: at most monthly. */
export const REMINDER_CADENCE_MS = 30 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The reminder notification's own words, shared by the writer and its tests. */
export const REMINDER_NOTIFICATION_TYPE = "upstream-release-reminder";

/** The notification action kind the reminder carries (web: `Notifications.Action`). */
export const REMINDER_ACTION_KIND = "equin-update";

/** The metadata key naming the release a reminder is about. */
export const REMINDER_RELEASE_KEY = "upstreamRelease";

/** What the reminder's action reads back from its payload. */
export const ReminderPayloadSchema = z.object({
  current: z.string().nullable(),
  latest: z.string(),
});
export type ReminderPayload = z.infer<typeof ReminderPayloadSchema>;

/** The reminder settings, as `upstreamReminderConfig` holds them. */
export interface ReminderSettings {
  enabled: boolean;
  snoozedUntil: Date;
  skippedRelease: string;
}

export interface ReminderInputs {
  settings: ReminderSettings;
  /** The release local `main` does not hold. */
  latest: string;
  /** A task about that release exists (an update is under way). */
  taskLive: boolean;
  /** When the newest reminder about `latest` was written (`null`: never). */
  lastRemindedAt: Date | null;
  now: Date;
}

/**
 * Why a reminder is (not) written now. The user hears of a release once, then
 * at most every `REMINDER_CADENCE_MS` — unless they chose when ("Remind me
 * later"): a snooze set after the last reminder replaces the cadence, so
 * "Tomorrow" really is tomorrow.
 */
export type ReminderDecision =
  | { kind: "remind" }
  | {
      kind: "quiet";
      reason: "disabled" | "snoozed" | "skipped" | "task-live" | "reminded";
    };

export function reminderDecision({
  settings,
  latest,
  taskLive,
  lastRemindedAt,
  now,
}: ReminderInputs): ReminderDecision {
  if (!settings.enabled) return { kind: "quiet", reason: "disabled" };
  if (settings.skippedRelease === latest)
    return { kind: "quiet", reason: "skipped" };
  if (taskLive) return { kind: "quiet", reason: "task-live" };
  if (now < settings.snoozedUntil) return { kind: "quiet", reason: "snoozed" };
  if (lastRemindedAt === null) return { kind: "remind" };
  // The user snoozed the last reminder: its time has come.
  if (settings.snoozedUntil > lastRemindedAt) return { kind: "remind" };
  return now.getTime() - lastRemindedAt.getTime() >= REMINDER_CADENCE_MS
    ? { kind: "remind" }
    : { kind: "quiet", reason: "reminded" };
}

/** The "Remind me later" menu's choices, in the order it lists them. */
export const LATER_CHOICES = [
  { id: "tomorrow", label: "Tomorrow" },
  { id: "week", label: "In a week" },
  { id: "month", label: "In a month" },
  { id: "skip", label: "Skip this release" },
  { id: "never", label: "Never" },
] as const;
export type LaterChoice = (typeof LATER_CHOICES)[number]["id"];

/** The one setting a "Remind me later" choice writes. */
export type ReminderWrite =
  | { key: "snoozedUntil"; value: Date }
  | { key: "skippedRelease"; value: string }
  | { key: "enabled"; value: false };

/**
 * A snooze ends at the START of the UTC day it lands on: the reminder is
 * written by a daily check (05:00 UTC), so "Tomorrow" is tomorrow's check —
 * not the day after, which a snooze ending at this hour tomorrow would wait
 * for whenever the click comes later in the day than the check.
 */
export function laterWrite(
  choice: LaterChoice,
  latest: string,
  now: Date,
): ReminderWrite {
  const after = (ms: number) => {
    const end = new Date(now.getTime() + ms);
    end.setUTCHours(0, 0, 0, 0);
    return { key: "snoozedUntil" as const, value: end };
  };
  switch (choice) {
    case "tomorrow":
      return after(DAY_MS);
    case "week":
      return after(7 * DAY_MS);
    case "month":
      return after(REMINDER_CADENCE_MS);
    case "skip":
      return { key: "skippedRelease", value: latest };
    case "never":
      return { key: "enabled", value: false };
  }
}
