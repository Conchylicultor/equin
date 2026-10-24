import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/**
 * When a background entry runs. Derived by its provider from the declaration —
 * never authored as prose, so it cannot drift from what actually happens.
 *
 * - `cron` — on a clock. `words` is the schedule in plain language ("Mondays
 *   03:40 UTC"), `expr` the crontab it was read from. `nextAt` is the next
 *   firing THIS backend has scheduled (ISO), `null` when this backend schedules
 *   none (a main-only job seen from a worktree) or it is past the lookahead.
 *   `disabled` — the schedule resolved to nothing (a setting turned it off).
 * - `event` — when something happens; `names` are the events, when known.
 * - `boot` — once, after the server starts.
 * - `on-demand` — only when something asks for it.
 * - `interval` — every `everyMs`, in process.
 * - `file-change` — when files it watches change on disk (a declared watcher).
 */
export const BackgroundTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    expr: z.string(),
    words: z.string(),
    nextAt: z.string().nullable(),
    disabled: z.boolean(),
  }),
  z.object({
    kind: z.literal("event"),
    names: wholeList(z.string(), {
      reason:
        "the events one job is bound to — its declared triggers, a handful",
    }),
  }),
  z.object({ kind: z.literal("boot") }),
  z.object({ kind: z.literal("on-demand") }),
  z.object({ kind: z.literal("interval"), everyMs: z.number() }),
  z.object({ kind: z.literal("file-change") }),
]);
export type BackgroundTrigger = z.infer<typeof BackgroundTriggerSchema>;

/**
 * Where it runs: only on the main backend, in every worktree backend, or on
 * the machine-wide central runtime.
 */
export const BackgroundScopeSchema = z.enum([
  "main",
  "every-worktree",
  "central",
]);
export type BackgroundScope = z.infer<typeof BackgroundScopeSchema>;

/**
 * How a run ended. `suspended` — the run handed its work off and returned to
 * wait (a durable workflow waiting on an event or timer, a supervised job whose
 * detached child is doing the work); the resumed run records the verdict.
 */
export const BackgroundRunOutcomeSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "suspended",
]);
export type BackgroundRunOutcome = z.infer<typeof BackgroundRunOutcomeSchema>;

/** One run. `finishedAt` / `durationMs` are `null` exactly while it runs. */
export const BackgroundRunSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outcome: BackgroundRunOutcomeSchema,
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
});
export type BackgroundRun = z.infer<typeof BackgroundRunSchema>;

/**
 * Counters over every run this backend has recorded. `null` on an entry whose
 * provider keeps no history — which is not the same as zero runs.
 */
export const BackgroundHistorySchema = z.object({
  runs: z.number().int(),
  failures: z.number().int(),
  lastSuccessAt: z.string().nullable(),
});
export type BackgroundHistory = z.infer<typeof BackgroundHistorySchema>;

/** A labelled fact a provider adds to the detail view ("Hold class: seconds"). */
export const BackgroundFactSchema = z.object({
  label: z.string(),
  value: z.string(),
});
export type BackgroundFact = z.infer<typeof BackgroundFactSchema>;

/** What a provider reports for one thing it runs. The catalog stamps `kind`. */
export const BackgroundEntryDraftSchema = z.object({
  /** The code name, unique within its kind (`ip-country.refresh`). */
  name: z.string(),
  /** One present-tense sentence a person reads — what it does and why. */
  description: z.string(),
  /**
   * The section it is listed under ("Scheduled", "Cleanup"). Chosen by the
   * provider, which knows its own declarations; the catalog imposes no list.
   */
  group: z.string(),
  trigger: BackgroundTriggerSchema,
  scope: BackgroundScopeSchema,
  /**
   * Whether this backend runs it at all. `false` for a main-only entry seen
   * from a worktree — its runs happen on main, so this backend has none to show.
   */
  runsHere: z.boolean(),
  /** The plugin that declared it, when the provider knows. */
  declaredIn: z.string().nullable(),
  /** The latest run in THIS backend, running or finished; `null` when none is
   * recorded. */
  lastRun: BackgroundRunSchema.nullable(),
  history: BackgroundHistorySchema.nullable(),
  /** Whether the Run now action is offered (the provider implements it and
   * the entry can start without caller input). */
  canRunNow: z.boolean(),
  /** Plumbing rather than work a person would recognise — hidden by default. */
  internal: z.boolean(),
  facts: wholeList(BackgroundFactSchema, {
    reason: "what one entry's provider says about it — a few labelled facts",
  }),
});
export type BackgroundEntryDraft = z.infer<typeof BackgroundEntryDraftSchema>;

/** One thing the app runs on its own, as the catalog lists it. */
export const BackgroundEntrySchema = BackgroundEntryDraftSchema.extend({
  /** The provider that reported it (`job`). With `name`, the entry's identity. */
  kind: z.string(),
});
export type BackgroundEntry = z.infer<typeof BackgroundEntrySchema>;

/** How many recent runs a history read returns at most. */
export const RECENT_RUNS_MAX = 20;

/**
 * An entry's recent runs: `tracked: false` when its provider keeps no run
 * history (distinct from "tracked, and it never ran" — an empty list).
 */
export const BackgroundRecentRunsSchema = z.discriminatedUnion("tracked", [
  z.object({
    tracked: z.literal(true),
    runs: z.array(BackgroundRunSchema).max(RECENT_RUNS_MAX),
  }),
  z.object({ tracked: z.literal(false) }),
]);
export type BackgroundRecentRuns = z.infer<typeof BackgroundRecentRunsSchema>;

/** The one spelling of an entry's identity, for keys and routes. */
export function backgroundEntryKey(entry: {
  kind: string;
  name: string;
}): string {
  return `${entry.kind}:${entry.name}`;
}
