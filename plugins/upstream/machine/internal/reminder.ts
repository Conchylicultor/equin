import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import { getConfig } from "@plugins/config_v2/server";
import {
  _notifications,
  recordNotification,
  restateByMetadata,
} from "@plugins/shell/plugins/notifications/server";
import { findSubjectTask } from "@plugins/tasks/plugins/task-subject/server";
import { releaseVersion } from "@plugins/upstream/plugins/release/core";
import { upstreamReminderConfig } from "../../shared/reminder-config";
import {
  REMINDER_ACTION_KIND,
  REMINDER_NOTIFICATION_TYPE,
  REMINDER_RELEASE_KEY,
  reminderDecision,
  type ReminderDecision,
  type ReminderPayload,
} from "../../shared/reminder";
import { upstreamReleaseSubject } from "../../shared/subject";
import { OUT_OF_DATE_TITLE, outOfDateSummary } from "../../shared/update-words";

/** When the newest reminder about `latest` was written, dismissed or not. */
async function lastRemindedAt(latest: string): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: _notifications.createdAt })
    .from(_notifications)
    .where(
      and(
        eq(_notifications.type, REMINDER_NOTIFICATION_TYPE),
        sql`${_notifications.metadata} ->> ${REMINDER_RELEASE_KEY} = ${latest}`,
      ),
    )
    .orderBy(desc(_notifications.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}

/**
 * The update reminder, after a check found `latest` missing from local `main`:
 * one user notification "equin is out of date" whose action (`equin-update`,
 * web) sends an agent or puts the reminder off — written only when
 * `reminderDecision` says it is due (once per release, then at most monthly or
 * when the user's snooze ends; never while reminders are off, the release is
 * skipped or an update task exists).
 *
 * Each reminder is its own row (the decision is the cadence, not a dedup
 * window); the day in its key keeps a re-run of the same day's job from
 * writing a second one.
 */
export async function remindOfRelease(
  current: string | null,
  latest: string,
  /** Commits `latest` holds that local `main` does not. */
  commits: number,
): Promise<ReminderDecision> {
  const now = new Date();
  const decision = reminderDecision({
    settings: getConfig(upstreamReminderConfig),
    latest,
    taskLive: (await findSubjectTask(upstreamReleaseSubject(latest))) !== null,
    lastRemindedAt: await lastRemindedAt(latest),
    now,
  });
  if (decision.kind !== "remind") return decision;
  const payload: ReminderPayload = { current, latest };
  await recordNotification({
    type: REMINDER_NOTIFICATION_TYPE,
    category: "updates",
    variant: "info",
    audience: "user",
    title: OUT_OF_DATE_TITLE,
    description: outOfDateSummary(current, latest, commits),
    metadata: { [REMINDER_RELEASE_KEY]: latest },
    dedupeKey: `${REMINDER_NOTIFICATION_TYPE}:${latest}:${now.toISOString().slice(0, 10)}`,
    action: { kind: REMINDER_ACTION_KIND, payload },
  });
  return decision;
}

/**
 * Local `main` holds upstream's newest release, `release`: every reminder —
 * about it or any earlier release, all now held — says so, in place (its
 * action draws nothing once the update is no longer to make).
 */
export async function settleReminders(release: string): Promise<void> {
  const reminded = await db
    .selectDistinct({
      // Every reminder names its release (`remindOfRelease` writes it).
      release:
        sql`${_notifications.metadata} ->> ${REMINDER_RELEASE_KEY}`.mapWith(
          parsed(z.string(), "the release a reminder names"),
        ),
    })
    .from(_notifications)
    .where(eq(_notifications.type, REMINDER_NOTIFICATION_TYPE));
  const state = {
    tone: "resolved" as const,
    text: `Updated to ${releaseVersion(release)}`,
  };
  for (const row of reminded)
    await restateByMetadata(REMINDER_RELEASE_KEY, row.release, state);
}
