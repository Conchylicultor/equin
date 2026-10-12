import { z } from "zod";

// A second, read-set-focused typed view of the `GET /api/resources/_debug`
// payload (the live-state-health pane declares its own subscriber-focused view
// of the same route). `shared/` is plugin-private, so we cannot import that
// other view — declaring a second contract over the same route is the
// established pattern, and zod strips unknown keys so the two coexist.
//
// We model only what this pane reads (zod strips the rest), and every field is
// REQUIRED: the server always emits them (central degrades each to `[]` /
// `null` / `false`), so a response that omits one fails loudly instead of
// reading as an entry with no reads, no routes or no drift. `policy` is parsed
// against the runtime's closed set, so a new policy the pane does not know is a
// parse error, not a silently-dropped entry.

/**
 * Per-resource notify provenance counters (L4 self-verifying parallel run).
 * `hand` = hand-called notify() invocations; `feed` = DB-change-feed-derived
 * ones; `producer` = deliveries from an in-process change producer (a table
 * the feed installs no trigger on, whose writes emit their own changes). A
 * resource with `hand > 0` and no change-source delivery at all is a
 * read-set-gap candidate — no change source covers a table the hand-notify
 * does (the bug class L4 eliminates). A feed- or producer-only resource is
 * expected (out-of-process writes or a now-redundant hand-notify).
 */
export const notifyStatsSchema = z.object({
  hand: z.number(),
  feed: z.number(),
  producer: z.number(),
});

/**
 * One route of a ROUTED resource (compiler-emitted — see
 * research/2026-09-29-global-scoped-change-routing.md): a table it is reached
 * through, how that table's rows map to its ids, and a `full` route's reason.
 */
export const routeSchema = z.union([
  z.object({
    id: z.string(),
    table: z.string(),
    map: z.literal("full"),
    reason: z.string(),
  }),
  z.object({
    id: z.string(),
    table: z.string(),
    map: z.enum(["identity", "alias", "reverse"]),
  }),
]);

/**
 * What one entry IS (A7, the runtime's `debugPolicyOf`): `routed` — reached
 * through its compiler-emitted routes; `legacy-full` — reached only by the
 * legacy router (a write to a relation base of its captured read-set recomputes
 * each tracked tuple FULL); `external` — declared outside Postgres, reached by
 * its own `notify()`; `unbound` — a deferred placeholder not bound yet. An
 * external or unbound entry with a captured read-set is ALSO reached by the
 * legacy router — `legacyReach` is that delivery truth, not the policy.
 */
export const policySchema = z.enum([
  "routed",
  "legacy-full",
  "external",
  "unbound",
]);

/**
 * An external value's declared freshness (`network/live`'s `changes`): told by
 * `notify` (`notified`), never told because its answer cannot change
 * (`immutable`, `fixed`), or re-measured only when a reader asks
 * (`snapshot`) — the last three with the author's reason.
 */
export const freshnessSchema = z.object({
  kind: z.enum(["notified", "immutable", "fixed", "snapshot"]),
  reason: z.string().optional(),
});

export const resourceReadSetSchema = z.object({
  key: z.string(),
  /** What this entry is — see `policySchema`. */
  policy: policySchema,
  /**
   * Captured table names this resource's loader read since boot (seeded from
   * the durable `tables_read`).
   */
  readSet: z.array(z.string()),
  /**
   * The bases under which the runtime's legacy router indexes this entry (the
   * router's own predicate: every non-routed entry, external and unbound ones
   * included): its captured read-set expanded through the relation bases —
   * views transitively, rollups to their sources (`agents_v` → `agents`;
   * `conversations_v` → `attempts, conversations, tasks`). A write to any of
   * them recomputes it FULL. `[]` for a routed entry, or one with no captured
   * reads.
   */
  legacyReach: z.array(z.string()),
  /** A routed resource's routes; `null` = not routed (see `policy`). */
  routes: z.array(routeSchema).nullable(),
  /**
   * The A8 drift guard's record for a routed resource: captured tables no route
   * names (raw-table space, as the guard judged them) — tables whose writes
   * never reach it. `[]` otherwise.
   */
  routeDrifted: z.array(z.string()),
  /** Subscribed params-tuples a change recomputes. */
  tuples: z.number(),
  /** L2-persisted (its value survives a restart and is kept current with nobody subscribed). */
  persisted: z.boolean(),
  /** Age of the persisted row's `position_at` as last known (ms); `null` if unknown or not persisted. */
  positionAgeMs: z.number().nullable(),
  /** Notify provenance counters (hand-called vs DB-change-feed-derived). */
  notifyStats: notifyStatsSchema,
  /** The declared freshness; `null` = none declared (a db entry, or one not served through `network/live`). */
  freshness: freshnessSchema.nullable(),
});

export const resourcesReadSetSchema = z.object({
  resources: z.array(resourceReadSetSchema),
});

export type NotifyStats = z.infer<typeof notifyStatsSchema>;
export type ResourceFreshness = z.infer<typeof freshnessSchema>;
export type ResourcePolicy = z.infer<typeof policySchema>;
export type ResourceReadSet = z.infer<typeof resourceReadSetSchema>;
export type ResourceRoute = z.infer<typeof routeSchema>;
export type ResourcesReadSet = z.infer<typeof resourcesReadSetSchema>;
