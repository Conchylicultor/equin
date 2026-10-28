import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@plugins/database/server";
import { _notifications } from "./tables";
import type { NotificationVariant } from "../../shared/schema";
import type { Audience } from "@plugins/audience/core";
import type { SymbolRef } from "@plugins/ui/plugins/icons/core";
import {
  notificationIdKind,
  type NotificationAction,
  type NotificationCategory,
  type NotificationId,
} from "../../core";

// Every column a notification write can set, with no rule tying `variant` to
// `linkTo`. Internal: only this plugin writes through it directly — the browser
// toast endpoint (click feedback) and the DB-backed suite. Everything else goes
// through `recordNotification`, whose input adds that rule.
export interface NotificationWrite {
  type: string;
  title: string;
  description: string;
  variant: NotificationVariant;
  linkTo?: string | null;
  metadata?: Record<string, unknown> | null;
  /**
   * What it is about, in the user's words — the bell's chips. Defaults to
   * `other`.
   */
  category?: NotificationCategory;
  /**
   * What it is about (a `conv-…` / `task-…` id) and its name as shown now — a
   * snapshot the bell shows exactly as the toast did (the view's line 2).
   */
  subjectId?: string | null;
  subjectName?: string | null;
  /** Developer-only internals (build id, exit code, HTTP status, raw error). */
  detail?: string | null;
  /** The one action, resolved in the browser by `kind` (`Notifications.Action`). */
  action?: NotificationAction | null;
  /**
   * The event's own glyph (`symbol("forum")`); without one the view draws the
   * variant's or the category's.
   */
  icon?: SymbolRef | null;
  /**
   * Quiet notification: keeps its variant color but is dimmed in the bell list,
   * excluded from the unread badge, and never pops a toast. Defaults to false.
   */
  muted?: boolean;
  /**
   * Who the notification is for: `developer` keeps it out of the bell of a user
   * not in Developer mode (equin's own telemetry — reports, crashes). Defaults
   * to `user` — for everyone, as a feature that declares no audience is.
   */
  audience?: Audience;
  /**
   * Deterministic key that collapses duplicate writes to a single row via a
   * UNIQUE index: a second write with the same key updates the existing row's
   * display fields (title/description/variant/linkTo/metadata/muted/category/subject/detail/action/icon) in place
   * rather than inserting a new row — so a deduped notification always reflects
   * its latest state (e.g. a crash whose noise classification flipped between
   * occurrences). The row's identity, creation time, and read/dismissed state
   * are preserved, so dedup alone collapses recurrences into one row; whether
   * that row re-alerts is the separate `resurfaceAfterMs` axis below.
   * Null/undefined means "no dedup" — Postgres
   * treats NULLs as non-conflicting, so a normal insert always happens.
   *
   * Every dedup hit (regardless of re-surface policy) bumps the row's `count`
   * and `lastSeenAt`, so a collapsed notification still reads as "happened N
   * times, last seen <ago>".
   */
  dedupeKey?: string | null;
  /**
   * Re-arm policy for a recurring deduped notification. When set, a dedup hit on
   * a row that last surfaced more than `resurfaceAfterMs` ago re-surfaces it —
   * resets `read`/`dismissed` to false and bumps `createdAt` to now, so it floats
   * back to the top of the bell as a fresh unread alert. A hit inside that window
   * only coalesces (count/lastSeenAt bump, no re-alert). Requires `dedupeKey` to
   * have any effect.
   *
   * Optional here, and omitting it really does mean "never resurface" — which is
   * right only for the callers that dedupe on a key unique per event
   * (conversation-created, build-finish, page reminders), where there is no
   * second occurrence to re-alert about. Callers whose key names a standing
   * problem must always pass one: the reports engine does, and enforces its own
   * floor on top so no report kind can opt out of re-alerting.
   */
  resurfaceAfterMs?: number;
  /**
   * Optional explicit row id. When provided it is used as the PK instead of a
   * generated one — clients pass their own id so the self-echo suppression
   * (recentClientIds) can match the stored row. Server-side callers omit it.
   */
  id?: NotificationId;
}

/**
 * A server-side notification. An `error` or `warning` must say where the user
 * can act on it — `linkTo` is required on those arms — so background work can
 * no longer drop a failure into the bell that nobody can click through. A
 * failure with no page of its own is a report: `recordReport` files it, and the
 * notification it writes links to the report's detail pane (Investigate). A
 * failed run that already owns a page (a build) links there.
 *
 * Browser click feedback ("Close failed") is not bound by this: it answers an
 * action the user is watching, and arrives over `POST /api/notifications`,
 * whose handler writes through the internal `writeNotification`.
 */
export type RecordNotificationInput = Omit<
  NotificationWrite,
  "variant" | "linkTo"
> &
  (
    | { variant: "info" | "success"; linkTo?: string | null }
    | { variant: "error" | "warning"; linkTo: string }
  );

export async function recordNotification(
  input: RecordNotificationInput,
  conn: NodePgDatabase = db,
): Promise<string> {
  return writeNotification(input, conn);
}

// db-parametrized for the same reason upsertReport is: the re-surface semantics
// live in the ON CONFLICT SQL, so the DB-backed suite drives THIS function
// against a throwaway Postgres rather than restating its CASE expressions.
// Production callers pass nothing and get the app pool.
export async function writeNotification(
  input: NotificationWrite,
  conn: NodePgDatabase = db,
): Promise<string> {
  const id = input.id ?? notificationIdKind.mint();
  const dedupKey = input.dedupeKey ?? null;
  const now = new Date();
  // Re-surface gate: a dedup hit re-alerts only once its row has been quiet (not
  // re-surfaced) for longer than the policy window. `createdAt` doubles as the
  // "last surfaced at" marker (it's bumped to now on every re-surface), so the
  // window check is `createdAt < now - resurfaceAfterMs`. Without a policy the
  // CASE collapses to "keep current value" — i.e. never resurface.
  const resurfaced =
    input.resurfaceAfterMs != null
      ? sql`(${_notifications.createdAt} < ${new Date(now.getTime() - input.resurfaceAfterMs)})`
      : sql`false`;
  const inserted = await conn
    .insert(_notifications)
    .values({
      id,
      type: input.type,
      title: input.title,
      description: input.description,
      variant: input.variant,
      linkTo: input.linkTo ?? null,
      metadata: input.metadata ?? null,
      muted: input.muted ?? false,
      audience: input.audience ?? "user",
      category: input.category ?? "other",
      subjectId: input.subjectId ?? null,
      subjectName: input.subjectName ?? null,
      detail: input.detail ?? null,
      action: input.action ?? null,
      icon: input.icon ?? null,
      dedupKey,
    })
    // null never conflicts, so a plain insert happens when no dedupeKey is set;
    // a colliding dedupeKey refreshes the existing row's display fields in place
    // (notably re-syncing `muted` to the producer's current classification) so a
    // deduped notification never drifts from its source, and always bumps
    // count/lastSeenAt. read/dismissed/createdAt re-surface only when the
    // resurface gate fires (recurring metric kinds); otherwise they're preserved
    // so identity-dedup recurrences collapse into one row without re-alerting.
    .onConflictDoUpdate({
      target: _notifications.dedupKey,
      set: {
        title: input.title,
        description: input.description,
        variant: input.variant,
        linkTo: input.linkTo ?? null,
        metadata: input.metadata ?? null,
        muted: input.muted ?? false,
        audience: input.audience ?? "user",
        category: input.category ?? "other",
        subjectId: input.subjectId ?? null,
        subjectName: input.subjectName ?? null,
        detail: input.detail ?? null,
        action: input.action ?? null,
        icon: input.icon ?? null,
        count: sql`${_notifications.count} + 1`,
        lastSeenAt: now,
        read: sql`CASE WHEN ${resurfaced} THEN false ELSE ${_notifications.read} END`,
        dismissed: sql`CASE WHEN ${resurfaced} THEN false ELSE ${_notifications.dismissed} END`,
        createdAt: sql`CASE WHEN ${resurfaced} THEN ${now} ELSE ${_notifications.createdAt} END`,
      },
    })
    .returning({ id: _notifications.id });
  // onConflictDoUpdate returns the row on both insert and update, so this is
  // populated whether the write was a fresh insert or a dedup hit.
  if (inserted[0]) {
    return inserted[0].id;
  }
  return id;
}
