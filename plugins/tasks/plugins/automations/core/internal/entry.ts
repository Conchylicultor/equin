import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import type { SymbolRef } from "@plugins/ui/plugins/icons/core";
import { TRIGGER_KINDS } from "./settings";

/** One thing an automation watches (a dependency updater, …), which the person
 * can include or exclude. */
export const AutomationSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
});
export type AutomationSource = z.infer<typeof AutomationSourceSchema>;

/**
 * How the automation can be woken and what it is woken by now.
 *
 * - `kinds` — the trigger kinds it supports, in its preferred order; the person
 *   picks one (its config's `trigger`) when there are several.
 * - `eventLabel` — what its event is, in words ("When a report is filed");
 *   `null` for an automation that supports only a schedule.
 * - `jobName` — the job it owns: the key its entry has in Background activity
 *   (`kind: "job"`), so Run now and the next run are read there.
 * - `current` — the kind its config picks now.
 * - `words` — when it runs, in the person's words ("Mondays at 06:00", or the
 *   event label).
 * - `cron` — the UTC crontab installed for it now: `null` while it is off, on
 *   its event, or its schedule is invalid (`scheduleError` says why).
 */
export const AutomationTriggerSchema = z.object({
  kinds: z.array(z.enum(TRIGGER_KINDS)).min(1),
  current: z.enum(TRIGGER_KINDS),
  words: z.string(),
  eventLabel: z.string().nullable(),
  jobName: z.string(),
  cron: z.string().nullable(),
  scheduleError: z.string().nullable(),
});
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

/** A `{{variable}}` its prompt template may use. */
export const PromptVariableSchema = z.object({
  name: z.string(),
  description: z.string(),
});

// The icon crosses the wire as the `SymbolRef` the server authored with
// `symbol("…")` — a tsc-checked literal the icon manifest collected. The check
// here is the shape; the name was checked where it was written.
const SymbolRefSchema: ZodParser<SymbolRef> = z.custom<SymbolRef>(
  (v) =>
    typeof v === "object" &&
    v !== null &&
    (v as { kind?: unknown }).kind === "symbol" &&
    typeof (v as { name?: unknown }).name === "string",
  "expected a symbol icon ref",
);

const AutomationEntryBaseSchema = z.object({
  id: z.string(),
  label: z.string(),
  icon: SymbolRefSchema,
  description: z.string(),
  enabled: z.boolean(),
  trigger: AutomationTriggerSchema,
  sources: z.array(AutomationSourceSchema),
  promptVariables: z.array(PromptVariableSchema),
});

/**
 * One registered automation, as the Automations pane lists it. Declared in code
 * (`defineAutomation`), so the set is bounded by the composition. Its settings
 * are its config document (`defineAutomationConfig`, named by its id), read
 * with the config hooks; `enabled` and the trigger are repeated here, as the
 * server resolves them, for the list.
 *
 * By kind (`AUTOMATION_KINDS`):
 * - `file` — `categoryId` is the category its filed tasks get; `openTaskId` is
 *   the task it filed that is neither done nor dropped — at most one, since it
 *   never files beside an open task.
 * - `launch` — `concurrency` is how many of its agents may run at once;
 *   `runningTaskIds` the tasks it launched that still hold a slot (not
 *   released, not settled), newest first; `maxLaunches` how many it launches
 *   once turned on before it turns itself off, `launchedInBatch` how many it
 *   has launched since it was last turned on (0 while off), and
 *   `approvedCount` how many tasks a person approved for it that it has not
 *   launched yet.
 */
export const AutomationEntrySchema = z.discriminatedUnion("kind", [
  AutomationEntryBaseSchema.extend({
    kind: z.literal("file"),
    categoryId: z.string(),
    openTaskId: z.string().nullable(),
  }),
  AutomationEntryBaseSchema.extend({
    kind: z.literal("launch"),
    concurrency: z.number().int(),
    runningTaskIds: z.array(z.string()),
    maxLaunches: z.number().int(),
    launchedInBatch: z.number().int(),
    approvedCount: z.number().int(),
  }),
]);
export type AutomationEntry = z.infer<typeof AutomationEntrySchema>;
