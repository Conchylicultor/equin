import {
  defineConfig,
  type ConfigDescriptor,
  type ConfigValues,
} from "@plugins/config_v2/core";
import type { FieldsRecord } from "@plugins/fields/core";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { enumField } from "@plugins/fields/plugins/enum/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { multilineTextField } from "@plugins/fields/plugins/multiline-text/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import { dynamicEnumField } from "@plugins/fields/plugins/dynamic-enum/plugins/config/core";
import {
  DEFAULT_MODEL_CHOICE,
  normalizeModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  AutomationSettingsSchema,
  CADENCE_LABELS,
  CADENCES,
  labeledOptions,
  PUSH_POLICIES,
  PUSH_POLICY_LABELS,
  TRIGGER_KIND_LABELS,
  TRIGGER_KINDS,
  WEEKDAY_LABELS,
  WEEKDAYS,
  type AutomationSettings,
  type Cadence,
  type PushPolicy,
  type TriggerKind,
  type Weekday,
} from "./settings";

/**
 * Every automation's config document is stored under this plugin's tree —
 * `config/tasks/automations/<id>.origin.jsonc` — whichever plugin declares
 * it, so the Automations pane finds each one by its name alone.
 */
export const AUTOMATIONS_CONFIG_PLUGIN_ID = asPluginId("tasks.automations");

/**
 * The one model field every automation's config shares: its options are the
 * live model catalog, contributed once (`DynamicEnum.Options`) for this field
 * object by the automations web plugin.
 */
export const automationModelField = dynamicEnumField({
  label: "Model",
  description: "The model every agent this automation launches runs with.",
  default: DEFAULT_MODEL_CHOICE,
});

/** What an automation's config starts as — the repo default the build writes. */
export interface AutomationConfigDefaults {
  enabled: boolean;
  push: PushPolicy;
  trigger: TriggerKind;
  /** The prompt template: the filed task's description, `{{variable}}` placeholders. */
  prompt: string;
  cadence?: Cadence;
  /** Local `HH:MM`. */
  at?: string;
  everyDays?: number;
  weekday?: Weekday;
  /** 5-field UTC crontab, used by the `cron` cadence. */
  cron?: string;
  settleMinutes?: number;
  excludedSources?: string[];
}

function automationFields(d: AutomationConfigDefaults) {
  return {
    enabled: boolField({
      label: "Enabled",
      description: "Off, it files nothing.",
      default: d.enabled,
    }),
    push: enumField({
      label: "Push",
      description:
        "What the agent may do with its finished work: never push, push only an uncontroversial change, or push once checks pass.",
      options: labeledOptions(PUSH_POLICIES, PUSH_POLICY_LABELS),
      default: d.push,
    }),
    model: automationModelField,
    excludedSources: stringListField({
      label: "Excluded sources",
      description: "The sources that do not take part.",
      default: d.excludedSources ?? [],
    }),
    trigger: enumField({
      label: "Trigger",
      description: "Run on a schedule, or when its event fires.",
      options: labeledOptions(TRIGGER_KINDS, TRIGGER_KIND_LABELS),
      default: d.trigger,
    }),
    cadence: enumField({
      label: "Schedule",
      description:
        "hour, day (at), days (every N days at), week (weekday at), or cron.",
      options: labeledOptions(CADENCES, CADENCE_LABELS),
      default: d.cadence ?? "day",
    }),
    at: textField({
      label: "At",
      description: "Local time, HH:MM.",
      default: d.at ?? "06:00",
    }),
    everyDays: intField({
      label: "Every N days",
      min: 2,
      max: 30,
      default: d.everyDays ?? 2,
    }),
    weekday: enumField({
      label: "Weekday",
      options: labeledOptions(WEEKDAYS, WEEKDAY_LABELS),
      default: d.weekday ?? "mon",
    }),
    cron: textField({
      label: "Cron",
      description:
        "5-field crontab in UTC (m h dom mon dow), for the cron schedule.",
      default: d.cron ?? "0 6 * * *",
    }),
    settleMinutes: intField({
      label: "Settle (minutes)",
      description:
        "An event-triggered run starts this long after the last event of a burst — at most 6× it after the first.",
      min: 1,
      max: 240,
      default: d.settleMinutes ?? 10,
    }),
    prompt: multilineTextField({
      label: "Prompt",
      description:
        "What the agent is told: the filed task's description, or the first prompt of an agent it launches on an existing task. {{variable}} placeholders are filled per task; {{pushPolicy}} says what the Push setting allows.",
      default: d.prompt,
      rows: 16,
    }),
  };
}

/** What a launch-kind automation's config starts as, beyond the common fields. */
export interface LaunchAutomationConfigDefaults extends AutomationConfigDefaults {
  /** How many of its agents may run at once. */
  concurrency: number;
  /** How many it launches in total once turned on, before it turns itself off. */
  maxLaunches: number;
}

/** The highest `maxLaunches` a launch-kind automation may be set to. */
export const MAX_LAUNCHES = 50;

/** The highest `concurrency` a launch-kind automation may be set to. */
export const MAX_LAUNCH_CONCURRENCY = 8;

function launchFields(d: LaunchAutomationConfigDefaults) {
  return {
    concurrency: intField({
      label: "At once",
      description:
        "How many of its agents may run at the same time. The next one starts when one finishes or reports.",
      min: 1,
      max: MAX_LAUNCH_CONCURRENCY,
      default: d.concurrency,
    }),
    maxLaunches: intField({
      label: "In total",
      description:
        "How many approved tasks it launches once turned on; then it turns itself off. Turning it back on starts a new count.",
      min: 1,
      max: MAX_LAUNCHES,
      default: d.maxLaunches,
    }),
  };
}

/** The fields every automation config has. */
export type AutomationConfigFields = ReturnType<typeof automationFields>;

/** The fields every launch-kind automation config has: the common ones,
 * `concurrency` and `maxLaunches`. */
export type LaunchAutomationConfigFields = AutomationConfigFields &
  ReturnType<typeof launchFields>;

/**
 * Declare an automation's config document: the common fields (`enabled`,
 * `push`, `model`, trigger and schedule, `prompt`, …) with this automation's
 * defaults, plus any fields of its own. Named by the automation id and stored
 * under `tasks/automations` (register it with `pluginId:
 * AUTOMATIONS_CONFIG_PLUGIN_ID` on both runtimes), so its defaults are
 * committed as `config/tasks/automations/<id>.origin.jsonc` and a person's
 * edits land in their own override.
 */
export function defineAutomationConfig<
  const X extends FieldsRecord = Record<never, never>,
>(id: string, defaults: AutomationConfigDefaults, extra?: X) {
  return defineConfig({
    name: id,
    fields: { ...automationFields(defaults), ...(extra ?? ({} as X)) },
  });
}

/**
 * Declare a launch-kind automation's config document: everything
 * `defineAutomationConfig` declares, plus `concurrency` — how many of its
 * agents run at once — and `maxLaunches` — how many it launches before it
 * turns itself off. Registered and stored exactly like a file-kind one.
 */
export function defineLaunchAutomationConfig<
  const X extends FieldsRecord = Record<never, never>,
>(id: string, defaults: LaunchAutomationConfigDefaults, extra?: X) {
  return defineConfig({
    name: id,
    fields: {
      ...automationFields(defaults),
      ...launchFields(defaults),
      ...(extra ?? ({} as X)),
    },
  });
}

/**
 * Whether an automation config document is a launch-kind one — the web pane
 * holds every document at the common shape and reaches `concurrency` through
 * this.
 */
export function isLaunchAutomationConfig(
  descriptor: ConfigDescriptor<AutomationConfigFields>,
): descriptor is ConfigDescriptor<LaunchAutomationConfigFields> {
  return "concurrency" in descriptor.fields;
}

/**
 * The common settings out of an automation config document — parsed, so a
 * value the enum fields admit but the settings do not (a hand edit) throws here
 * rather than reaching a run.
 */
export function readAutomationSettings(
  values: ConfigValues<AutomationConfigFields>,
): AutomationSettings {
  return AutomationSettingsSchema.parse({
    enabled: values.enabled,
    push: values.push,
    model: normalizeModelChoice(values.model),
    excludedSources: values.excludedSources,
    trigger: values.trigger,
    schedule: {
      cadence: values.cadence,
      at: values.at,
      everyDays: values.everyDays,
      weekday: values.weekday,
      cron: values.cron,
    },
    settleMinutes: values.settleMinutes,
    prompt: values.prompt,
  });
}
