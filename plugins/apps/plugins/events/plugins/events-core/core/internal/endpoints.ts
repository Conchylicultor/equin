import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { EventSourceSchema } from "./schema";
import { REFRESH_CADENCES } from "./vocab";

// Source CRUD + one run's touched-events read. The run ledger itself is the
// live `events.source-runs` collection (`./resources.ts`). `events` rows themselves are NOT served
// here — they are a server-delegated DataView query owned by `event-list`.

export const CreateEventSourceBodySchema = z.object({
  /** Must name a registered `EventSourceType.id`; an unknown type is a 400. */
  type: z.string(),
  /** Defaulted server-side (from the config's URL host, else the type id). */
  name: z.string().optional(),
  /** Validated against the source type's own `configFields`. */
  config: z.record(z.string(), z.unknown()),
  refresh: z.enum(REFRESH_CADENCES).optional(),
  enabled: z.boolean().optional(),
});
export type CreateEventSourceBody = z.infer<typeof CreateEventSourceBodySchema>;

/**
 * The autosave PATCH behind every field edit. `type` is absent on purpose: a
 * source's type is its identity (its `config` shape and its extractor both hang
 * off it) — retyping a row is a delete + create, not an edit.
 *
 * A supplied `config` REPLACES the stored one and is revalidated in full, so a
 * partial write can never leave a row whose config fails its type's schema.
 */
export const UpdateEventSourceBodySchema = z.object({
  name: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  refresh: z.enum(REFRESH_CADENCES).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateEventSourceBody = z.infer<typeof UpdateEventSourceBodySchema>;

export const listEventSources = defineEndpoint({
  route: "GET /api/events/sources",
  response: z.array(EventSourceSchema),
});

export const getEventSource = defineEndpoint({
  route: "GET /api/events/sources/:id",
  response: EventSourceSchema,
});

export const createEventSource = defineEndpoint({
  route: "POST /api/events/sources",
  body: CreateEventSourceBodySchema,
  response: EventSourceSchema,
});

export const updateEventSource = defineEndpoint({
  route: "PATCH /api/events/sources/:id",
  body: UpdateEventSourceBodySchema,
  response: EventSourceSchema,
});

export const deleteEventSource = defineEndpoint({
  route: "DELETE /api/events/sources/:id",
});

/**
 * The outcome of asking for a refresh — a discriminated result, never a bare
 * boolean, because "we did not start a run" has several genuinely different
 * meanings the UI must distinguish. A `false` (or a `null`) would collapse the
 * disabled-source case onto the already-running case onto a real failure.
 *
 * Things that are NOT in this union because they are errors, not outcomes: an
 * unknown source id (404), a source whose `type` has no registered source type
 * (500 — a broken install), and no refresh engine registered at all (503).
 */
export const RefreshSourceResultSchema = z.discriminatedUnion("status", [
  /** A run was enqueued. `runId` is absent until the engine actually starts it. */
  z.object({ status: z.literal("enqueued") }),
  /** A run for this source is already in flight; the request coalesced into it. */
  z.object({ status: z.literal("already-running") }),
  /** Refused, with a reason the UI can render verbatim. */
  z.object({
    status: z.literal("skipped"),
    reason: z.enum(["disabled"]),
    message: z.string(),
  }),
]);
export type RefreshSourceResult = z.infer<typeof RefreshSourceResultSchema>;

/** Manual "Refresh now". Works in any worktree (only the cadence tick is main-only). */
export const refreshEventSourceNow = defineEndpoint({
  route: "POST /api/events/sources/:id/refresh",
  response: RefreshSourceResultSchema,
});

/**
 * The outcome of "Refresh all" — a TALLY of the very same per-source
 * `RefreshSourceResult` arms, never a boolean, for the reason that union exists:
 * "we did not start 3 of them" has to be sayable. A caller renders it arm by
 * arm; a resolved promise is not "everything refreshed".
 *
 * DISABLED sources are not candidates and are therefore counted NOWHERE — they
 * are not a "skip", because nothing was asked of them. `skipped` can still be
 * non-zero: a source disabled between the listing and its own enqueue is a
 * genuine refusal of a request we did make.
 */
export const RefreshAllResultSchema = z.object({
  enqueued: z.number().int().nonnegative(),
  alreadyRunning: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type RefreshAllResult = z.infer<typeof RefreshAllResultSchema>;

/**
 * Refresh every enabled source. Cannot collide with
 * `POST /api/events/sources/:id/refresh` — that route has one more path
 * segment, so `refresh-all` is never mistaken for a source id.
 */
export const refreshAllEventSources = defineEndpoint({
  route: "POST /api/events/sources/refresh-all",
  response: RefreshAllResultSchema,
});
