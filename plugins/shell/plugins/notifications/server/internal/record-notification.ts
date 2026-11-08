import { and, eq, lt, or, sql } from "drizzle-orm";
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
   * occurrences). The row's identity, position (`createdAt`) and read/dismissed
   * state are never touched by a dedup hit; whether a recurrence becomes a NEW
   * row is the separate `resurfaceAfterMs` axis below.
   * Null/undefined means "no dedup" — Postgres
   * treats NULLs as non-conflicting, so a normal insert always happens.
   *
   * Every dedup hit that does not open a new episode bumps the row's `count`
   * and `lastSeenAt`, so a collapsed notification still reads as "happened N
   * times, last seen <ago>".
   */
  dedupeKey?: string | null;
  /**
   * Re-alert policy for a recurring deduped notification. A recurrence that
   * opens a new EPISODE files a new row, at the top of the bell, unread: the
   * key's current row went quiet (`lastSeenAt`) for longer than
   * `resurfaceAfterMs`, or the user dismissed it and it last surfaced
   * (`createdAt`) longer ago than that. The earlier row releases the key and
   * stays exactly where it is, with its own read/dismissed state and count —
   * a notification is never moved and never un-dismissed (moving a row is
   * dismissing what was below it; the DB refuses a `created_at` change). Any
   * other hit only coalesces into the current row (count/lastSeenAt bump).
   * Requires `dedupeKey` to have any effect.
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

// db-parametrized for the same reason upsertReport is: the re-alert semantics
// live in SQL (the key release and the ON CONFLICT), so the DB-backed suite
// drives THIS function against a throwaway Postgres rather than restating them.
// Production callers pass nothing and get the app pool.
export async function writeNotification(
  input: NotificationWrite,
  conn: NodePgDatabase = db,
): Promise<string> {
  const id = input.id ?? notificationIdKind.mint();
  const dedupKey = input.dedupeKey ?? null;
  const now = new Date();
  const resurfaceAfterMs = input.resurfaceAfterMs;
  if (dedupKey === null || resurfaceAfterMs === undefined) {
    return insertOrCoalesce(conn, id, dedupKey, now, input);
  }
  // A new episode: the key's current row releases the key (and keeps its
  // place, its state and its count), so the insert below files a new row. Two
  // plain writes, no transaction needed: a concurrent writer finds the key
  // already released, releases nothing, and coalesces into the new row through
  // ON CONFLICT; an insert that fails after the release leaves the old row
  // keyless, and the next occurrence files the new row.
  const cutoff = new Date(now.getTime() - resurfaceAfterMs);
  await conn
    .update(_notifications)
    .set({ dedupKey: null })
    .where(
      and(
        eq(_notifications.dedupKey, dedupKey),
        or(
          lt(_notifications.lastSeenAt, cutoff),
          and(
            eq(_notifications.dismissed, true),
            lt(_notifications.createdAt, cutoff),
          ),
        ),
      ),
    );
  return insertOrCoalesce(conn, id, dedupKey, now, input);
}

async function insertOrCoalesce(
  conn: NodePgDatabase,
  id: NotificationId,
  dedupKey: string | null,
  now: Date,
  input: NotificationWrite,
): Promise<string> {
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
    // count/lastSeenAt. Its position (createdAt) and read/dismissed state are
    // the user's view of it and never change here.
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
