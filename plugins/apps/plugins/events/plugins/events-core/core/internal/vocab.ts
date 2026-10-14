// The Events app's closed vocabularies. Plain `core/` data, NOT slots: per the
// root CLAUDE.md collection rule, a list you can enumerate today and that BOTH
// runtimes need is data — a slot would buy an open set nobody can add to
// meaningfully and cost a web↔server codegen bridge.
//
// Each list feeds `enumTextField(...)` in `./fields.ts`, so the DB column stays
// a plain `text` while the TS value type is the exact union. The category list
// is additionally handed verbatim to the extraction prompt, which is why it must
// be one array both sides read.

import type { FieldOptionMeta } from "@plugins/fields/core";

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Event categories. Promote to a registry only when a source type must add one. */
export const EVENT_CATEGORIES = [
  "music",
  "party",
  "club",
  "tech",
  "art",
  "food",
  "sport",
  "community",
  "other",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/** How each category presents (the `category` field's options): its name, capitalised. */
export const EVENT_CATEGORY_META = Object.fromEntries(
  EVENT_CATEGORIES.map((c) => [c, { label: cap(c) }]),
) as { readonly [C in EventCategory]: FieldOptionMeta };

/** How often a source is re-probed. `manual` is never picked up by the scheduler. */
export const REFRESH_CADENCES = [
  "manual",
  "hourly",
  "daily",
  "weekly",
] as const;
export type RefreshCadence = (typeof REFRESH_CADENCES)[number];

/** Runtime state of a source row, written by the refresh engine. */
export const SOURCE_STATUSES = ["idle", "running", "error"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/**
 * How a single refresh run ended.
 * - `unchanged` — the probe fingerprint matched; extraction was NOT run (this is
 *   the cache assertion: no model call was paid for).
 * - `extracted` — the fingerprint moved, extraction ran, the diff was upserted.
 * - `failed` — probe or extract threw; the classified error lands on the source row.
 */
export const RUN_OUTCOMES = ["unchanged", "extracted", "failed"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** How each run outcome presents (the `outcome` field's options): its label and chip tint. */
export const RUN_OUTCOME_META: { readonly [O in RunOutcome]: FieldOptionMeta } =
  {
    // Named for what it MEANS, not for the enum value: "Unchanged" alone reads
    // as "nothing happened / something is broken", which is exactly the
    // question the run ledger exists to answer. The saved model call is the
    // headline.
    unchanged: { label: "Unchanged", variant: "muted" },
    extracted: { label: "Extracted", variant: "success" },
    failed: { label: "Failed", variant: "destructive" },
  };

/**
 * What the sources list answers when the user asks "is this source working?".
 *
 * DERIVED from the source row's `lastOutcome` + `lastEventCount` (see
 * `./extraction-status.ts`) and NEVER stored: one fact — the run ledger's
 * outcome and count, written atomically with the run row — with one derivation
 * on top of it, so there is no stored copy that can drift from the ledger.
 *
 * `empty` is deliberately its own arm and NOT an error: a successful extraction
 * that found nothing is the single most common way a source goes silently broken
 * (the site changed its markup, the scrape still "succeeds", zero events land),
 * and folding it into `ok` is exactly what hides it. It is also a legitimate
 * answer — a venue with nothing on — which is why it is not `failed` either.
 */
export const EXTRACTION_STATUSES = ["never", "ok", "empty", "failed"] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/**
 * What ONE run did to ONE event — the per-event detail behind the run row's
 * four counts.
 *
 * `disappeared` belongs here with the other two because it is something the
 * extraction did (it listed the source in full and this event was not in it),
 * not a separate kind of record. There is deliberately no `unchanged` member: an
 * extraction re-upserts every event it lists, so "seen again, identical" is an
 * `updated` — the diff is against the DB row, not against the previous run.
 */
export const RUN_EVENT_ACTIONS = ["created", "updated", "disappeared"] as const;
export type RunEventAction = (typeof RUN_EVENT_ACTIONS)[number];
