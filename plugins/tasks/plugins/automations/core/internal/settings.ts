import { z } from "zod";
import { ModelChoiceSchema } from "@plugins/conversations/plugins/model-provider/core";

/**
 * What the filed task's agent may do with its finished work.
 *
 * - `never` — stop at a ready branch and raise a flag; a person pushes.
 * - `safe` — push only an uncontroversial change (small, local, no behaviour or
 *   API a person relies on, no design choice); otherwise stop and flag what
 *   needs a decision.
 * - `checks` — push as soon as every check passes.
 */
export const PUSH_POLICIES = ["never", "safe", "checks"] as const;
export type PushPolicy = (typeof PUSH_POLICIES)[number];
export const PUSH_POLICY_LABELS: Record<PushPolicy, string> = {
  never: "Never",
  safe: "If uncontroversial",
  checks: "When checks pass",
};

/**
 * What an automation does with the work it finds.
 *
 * - `file` — `detect` finds work and the automation files ONE task for it and
 *   launches its agent; it files nothing more while that task is open.
 * - `launch` — `candidates` names EXISTING tasks, best first, and the
 *   automation launches agents on them, at most `concurrency` at a time; the
 *   next starts when one settles.
 */
export const AUTOMATION_KINDS = ["file", "launch"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

/**
 * What an automation did to a task, on its origin row: it `filed` the task
 * (and launched it), or it only `launched` a task someone else filed — the
 * task stays that person's.
 */
export const ORIGIN_ROLES = ["filed", "launched"] as const;
export type OriginRole = (typeof ORIGIN_ROLES)[number];

/**
 * What a person decided about launching a task with a launch-kind automation,
 * on its decision row: `approved` — it may launch it; `excluded` — it never
 * proposes it again until restored. A task with no row is undecided, and a
 * launch-kind automation launches ONLY approved tasks: nothing a person did
 * not approve ever starts, whatever the automation ranks first.
 */
export const LAUNCH_DECISIONS = ["approved", "excluded"] as const;
export type LaunchDecision = (typeof LAUNCH_DECISIONS)[number];

/**
 * The task statuses that free a launch-kind automation's slot on their own:
 * the task landed or was dropped, its agent went away without reporting
 * (`attempted` — counted as finished, and flagged), or a person held it (the
 * task is theirs to resume; waiting on it would stall the automation with
 * nothing in sight). A task also stops holding a slot once it is released
 * (`releaseLaunchedTask`, e.g. its agent submitted its report).
 */
export const SLOT_SETTLED_STATUSES = [
  "done",
  "dropped",
  "attempted",
  "held",
] as const;

/** How an automation is woken: on a schedule, or when its event fires. */
export const TRIGGER_KINDS = ["schedule", "event"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
export const TRIGGER_KIND_LABELS: Record<TriggerKind, string> = {
  schedule: "On a schedule",
  event: "On event",
};

/** The schedule presets a person picks from; `cron` is the escape hatch. */
export const CADENCES = ["hour", "day", "days", "week", "cron"] as const;
export type Cadence = (typeof CADENCES)[number];
export const CADENCE_LABELS: Record<Cadence, string> = {
  hour: "Hourly",
  day: "Daily",
  days: "Every N days",
  week: "Weekly",
  cron: "Custom",
};

export const WEEKDAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** `{ value, label }` options in the closed set's order, labels from its map. */
export function labeledOptions<K extends string>(
  values: readonly K[],
  labels: Record<K, string>,
): { value: K; label: string }[] {
  return values.map((value) => ({ value, label: labels[value] }));
}

/**
 * When a schedule-triggered automation runs, as the person set it. `at` is a
 * local wall-clock `HH:MM` (`day` / `days` / `week`); `cron` is a 5-field UTC
 * crontab (`cron` only). The other fields are kept while unused, so switching
 * preset and back restores them.
 */
export const ScheduleSettingsSchema = z.object({
  cadence: z.enum(CADENCES),
  at: z.string(),
  everyDays: z.number().int(),
  weekday: z.enum(WEEKDAYS),
  cron: z.string(),
});
export type ScheduleSettings = z.infer<typeof ScheduleSettingsSchema>;

/**
 * How an automation behaves, as its config document says — the fields every
 * automation's config has (`defineAutomationConfig`); an automation may add its
 * own beside them.
 *
 * - `enabled` — off, its job files nothing (and a schedule is not installed).
 * - `push` — what the filed task's agent may do with its work.
 * - `model` — the model the filed task's agent launches with.
 * - `excludedSources` — the ids of the declared sources that do not take part.
 * - `trigger` — schedule or event (only among the kinds it supports).
 * - `schedule` — when a schedule-triggered run happens.
 * - `settleMinutes` — an event-triggered run starts this long after the LAST
 *   event of a burst (at most 6× it after the first).
 * - `prompt` — the task's description template, `{{variable}}` placeholders.
 */
export const AutomationSettingsSchema = z.object({
  enabled: z.boolean(),
  push: z.enum(PUSH_POLICIES),
  model: ModelChoiceSchema,
  excludedSources: z.array(z.string()),
  trigger: z.enum(TRIGGER_KINDS),
  schedule: ScheduleSettingsSchema,
  settleMinutes: z.number().int(),
  prompt: z.string(),
});
export type AutomationSettings = z.infer<typeof AutomationSettingsSchema>;

/** The longest an event-triggered run waits, in multiples of `settleMinutes`. */
export const SETTLE_MAX_WAIT_FACTOR = 6;
