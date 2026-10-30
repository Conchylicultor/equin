import type { ConfigDescriptor, ConfigValues } from "@plugins/config_v2/core";
import type { SymbolRef } from "@plugins/ui/plugins/icons/core";
import type {
  AutomationConfigFields,
  LaunchAutomationConfigFields,
  AutomationSettings,
  AutomationSource,
  PromptVariable,
  TriggerKind,
} from "../../core";
import type { AutomationFiling } from "./origin";
import type {
  MandatePolicy,
  MandateRef,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/** What `detect` is handed: only what the person let take part. */
export interface AutomationDetectCtx<
  F extends AutomationConfigFields = AutomationConfigFields,
> {
  /** The declared sources the settings do not exclude (all of them for an
   * automation that declares none: `[]`). */
  sources: AutomationSource[];
  /** The resolved common settings this run uses. */
  settings: AutomationSettings;
  /** The whole config document — the automation's own fields included. */
  config: ConfigValues<F>;
  /** Aborted when the run overruns its job's budget — thread it into any wait. */
  signal: AbortSignal;
  /**
   * Record that one source failed while the others still answered. The run
   * files what the others found, then throws every recorded failure together,
   * so a partial outage neither hides nor blocks the rest.
   */
  partialFailure(err: unknown): void;
}

/** What a launch-kind automation's `candidates` is handed. */
export interface AutomationLaunchCtx<
  F extends LaunchAutomationConfigFields = LaunchAutomationConfigFields,
> {
  /** The declared sources the settings do not exclude. */
  sources: AutomationSource[];
  /** The resolved common settings this run uses. */
  settings: AutomationSettings;
  /** The whole config document — the automation's own fields included. */
  config: ConfigValues<F>;
  /** Aborted when the run overruns its job's budget — thread it into any wait. */
  signal: AbortSignal;
}

/**
 * One existing task a launch-kind automation would start, with the values of
 * its prompt template's `{{variables}}` for that task (the registry adds
 * `pushPolicy`).
 */
export interface LaunchCandidate {
  taskId: string;
  variables: Readonly<Record<string, string>>;
}

/** What every automation declares, whatever its kind. */
interface AutomationSpecBase<F extends AutomationConfigFields> {
  /** Stable id: the config document's name, the job name's suffix, the origin rows' key. */
  id: string;
  /** What it is, for a person ("Dependency upgrades"). */
  label: string;
  icon: SymbolRef;
  /** What it watches and what it does, in one or two sentences. */
  description: string;
  /**
   * Its settings: `defineAutomationConfig(id, …)` (launch kind:
   * `defineLaunchAutomationConfig`), registered by the declaring plugin on
   * both runtimes with `pluginId: AUTOMATIONS_CONFIG_PLUGIN_ID`.
   */
  config: ConfigDescriptor<F>;
  /**
   * The trigger kinds it supports (its config's `trigger` picks one). An
   * `event` automation names its event in words and is woken by the plugin
   * that sees the event calling the handle's `fire()`.
   */
  triggers:
    | { kinds: readonly ["schedule"] }
    | {
        kinds: readonly [TriggerKind, ...TriggerKind[]];
        eventLabel: string;
      };
  /**
   * Why its run may hold a job slot in process (its job holds one for
   * minutes): what it does and what bounds it. Required by the jobs plugin for
   * `minutes`.
   */
  inProcess: string;
  /** The things it watches that a person can include or exclude. Absent ⇒ none. */
  sources?: () => AutomationSource[];
  /**
   * The `{{variables}}` its prompt template may use — every one a filing (or a
   * launch candidate) fills. `{{pushPolicy}}` is offered to every automation
   * on top.
   */
  promptVariables: readonly PromptVariable[];
  /**
   * What the agents it starts may do — the grants of its named mandate
   * (`automation:<id>`), which it names on each task: the ROOT task it files
   * (file kind), or a nested mandate on each task it launches (launch kind;
   * nearest wins over the task's own tree). Required: an automation decides
   * its agents' powers, from its current settings (the Push setting is
   * `settings.push`) — read at every resolution, so a settings change reaches
   * every tree it started.
   */
  mandate: (settings: AutomationSettings) => MandatePolicy;
}

/**
 * A file-kind automation (the default): something that files a task and
 * launches its agent with nobody clicking anything. Declared once, in the
 * plugin that knows what to watch; the registry owns everything else — the
 * job, the trigger, the settings, the dedupe, the prompt, the filing, the
 * launch and the origin record.
 */
export interface FileAutomationSpec<
  F extends AutomationConfigFields = AutomationConfigFields,
> extends AutomationSpecBase<F> {
  kind?: "file";
  /** The task category the filed tasks are stamped with. */
  categoryId: string;
  /**
   * What watches each task it files, beside `mandate` — required, so every
   * file automation states it:
   * - `"refire"` — the `automations.refire` code watcher: the task settling
   *   (done or dropped) runs the automation again at once, so the next piece
   *   of work is filed without waiting for its next event or schedule.
   * - `null` — nothing; the next scheduled or fired run looks again. Pick it
   *   when detecting again right after a settle would re-file the same work
   *   (a dropped upgrade is still outdated).
   *
   * A launch-kind automation declares none: the `automations.slot` watcher
   * on each task it launches is what holds and frees its slots.
   */
  watch: "refire" | null;
  /**
   * Look for work. Runs only while the automation is enabled and has no open
   * task. `null` ⇒ nothing to do.
   */
  detect(ctx: AutomationDetectCtx<F>): Promise<AutomationFiling | null>;
  /**
   * Transition only: the ids of tasks this automation filed before origins
   * were stored, so the dedupe and the history see them. Adopted at boot and
   * before every run, idempotently. Delete once no such task can be open.
   */
  adoptLegacy?: () => Promise<string[]>;
}

/**
 * A launch-kind automation: it files nothing — it starts agents on tasks that
 * already exist, at most `concurrency` (its config) at a time, the next one
 * when a slot frees. The plugin says which tasks (`candidates`); the registry
 * owns the slots, the prompt, the origin record (role `launched`) and the
 * armed launch.
 */
export interface LaunchAutomationSpec<
  F extends LaunchAutomationConfigFields = LaunchAutomationConfigFields,
> extends AutomationSpecBase<F> {
  kind: "launch";
  /**
   * The tasks it would start now, BEST FIRST. Runs only while it is enabled
   * and has a free slot. The registry skips a task an automation already filed
   * or launched, or one someone already armed, then launches the first ones
   * that fit — so return a bounded list, not just enough to fill the slots.
   */
  candidates(ctx: AutomationLaunchCtx<F>): Promise<LaunchCandidate[]>;
}

/** An automation of either kind, at the common config shape. */
export type AutomationSpec = FileAutomationSpec | LaunchAutomationSpec;

/** A registered automation and the job it owns. */
export interface RegisteredAutomation {
  spec: AutomationSpec;
  jobName: string;
  /**
   * Its named mandate (`automation:<id>`): what every task it files or
   * launches names, granting `spec.mandate` of its CURRENT settings at each
   * resolution (the `automations` MandateDefinitions.Source).
   */
  mandate: MandateRef;
  /**
   * Run its job as soon as possible, whatever its trigger — for a launch-kind
   * automation whose slots may have moved (a task it launched settled or was
   * released, its config changed, the backend booted). A no-op off main or
   * while it is off.
   */
  wake(): void;
}

// Filled during the register phase. Process state: the set is what this
// backend's composition declares.
const automations = new Map<string, RegisteredAutomation>();

export function addAutomation(entry: RegisteredAutomation): void {
  if (automations.has(entry.spec.id)) {
    throw new Error(
      `[automations] duplicate automation id "${entry.spec.id}" — each automation declares its own id`,
    );
  }
  automations.set(entry.spec.id, entry);
}

/** Every registered automation, in registration order. */
export function registeredAutomations(): RegisteredAutomation[] {
  return [...automations.values()];
}

/** The registered automation `id`, or `undefined` when this composition has none. */
export function registeredAutomation(
  id: string,
): RegisteredAutomation | undefined {
  return automations.get(id);
}
