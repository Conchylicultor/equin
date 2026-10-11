import { z } from "zod";
import type { Registration } from "@plugins/framework/plugins/server-core/core";
import { getConfig, setConfig } from "@plugins/config_v2/server";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { armTaskAutoStart } from "@plugins/tasks/server";
import { listArmedTaskIds } from "@plugins/tasks/plugins/auto-start/server";
import {
  PUSH_POLICY_TEXT,
  renderPrompt,
  SETTLE_MAX_WAIT_FACTOR,
  type AutomationConfigFields,
  type AutomationSettings,
  type LaunchAutomationConfigFields,
} from "../../core";
import { automationsCatalogServed } from "./live";
import {
  adoptAutomationTasks,
  fileAutomationTask,
  occupiedSlotTaskIds,
  openAutomationTaskId,
  recordLaunch,
  taskIdsWithOrigin,
} from "./origin";
import {
  addAutomation,
  type AutomationSpec,
  type FileAutomationSpec,
  type LaunchAutomationSpec,
} from "./registry";
import { batchRemaining, freeSlots, selectLaunches } from "./slots";
import { approvedTaskIds } from "./decisions";
import { launchedSince, openLaunchBatch } from "./launch-batch";
import {
  automationCron,
  automationSettings,
  includedSources,
} from "./settings";

const log = Log.channel("automations");

// A burst re-enqueues the pending run at most this often: each event pushes the
// run's start later, but moving it by less than this is not worth a queue write.
const RESCHEDULE_GRANULARITY_MS = 30_000;

/** A declared automation: mount it in the plugin's `register: [...]`. */
export interface Automation extends Registration {
  readonly id: string;
  /** The job it owns (`automation.<id>`) — its Background activity entry. */
  readonly jobName: string;
  /**
   * Its event happened. While it is on and set to its event, this schedules a
   * run `settleMinutes` after the LAST event of a burst (at most 6× that after
   * the first), so a burst becomes one run. Cheap and synchronous — call it
   * from the hot path that sees the event. Main only: a worktree backend's
   * events file nothing.
   */
  fire(): void;
}

/** What one run did — the line it logs. */
function runAutomation(
  spec: AutomationSpec,
  signal: AbortSignal,
): Promise<string> {
  return spec.kind === "launch"
    ? runLaunch(spec, signal)
    : runFiling(spec, signal);
}

/** A file-kind run: detect → file ONE task → arm it; nothing while one is open. */
async function runFiling(
  spec: FileAutomationSpec,
  signal: AbortSignal,
): Promise<string> {
  const settings = automationSettings(spec);
  if (!settings.enabled) return "disabled; nothing filed";

  if (spec.adoptLegacy) await adoptLegacy(spec);
  const open = await openAutomationTaskId(spec.id);
  if (open !== null) return `task ${open} is still open; nothing filed`;

  const failures: unknown[] = [];
  const filing = await spec.detect({
    sources: includedSources(spec.sources?.() ?? [], settings),
    settings,
    config: getConfig(spec.config),
    signal,
    partialFailure: (err) => failures.push(err),
  });

  let outcome = "nothing to do";
  if (filing !== null) {
    const prompt = fillPrompt(spec, settings, filing.variables);
    const taskId = await fileAutomationTask({
      automationId: spec.id,
      categoryId: spec.categoryId,
      filing,
      description: prompt,
    });
    automationsCatalogServed.notify();
    if (filing.onFiled) await filing.onFiled(taskId);
    // The prompt IS the task's description here, so the marker needs none of
    // its own: the launch builds the same text from the task.
    await armTaskAutoStart({
      taskId,
      model: settings.model,
      cause: `automation:${spec.id}`,
    });
    outcome = `${filing.title}; filed auto-started task ${taskId}`;
  }
  if (failures.length > 0) {
    log.publish(`automation ${spec.id}: ${outcome}`);
    throw new AggregateError(
      failures,
      `automation ${spec.id}: ${failures.length} source(s) failed to detect`,
    );
  }
  return outcome;
}

/**
 * A launch-kind run — the pump: count the slots its launched tasks still hold
 * and what is left of its batch (`maxLaunches` since it was turned on), ask
 * `candidates` only when both allow one, and start the first APPROVED ones
 * that fit — each recorded as launched (its origin row) and armed with the
 * filled prompt ON the marker, so whichever path claims the marker launches
 * with it. A task no person approved never starts. Once the batch is spent it
 * turns itself off (its config), exactly as if the person had: agents still
 * running finish.
 */
async function runLaunch(
  spec: LaunchAutomationSpec,
  signal: AbortSignal,
): Promise<string> {
  const settings = automationSettings(spec);
  if (!settings.enabled) return "disabled; nothing launched";
  const config = getConfig(spec.config);

  const batchStartedAt = await openLaunchBatch(spec.id);
  const [running, launchedBefore] = await Promise.all([
    occupiedSlotTaskIds(spec.id),
    launchedSince(spec.id, batchStartedAt),
  ]);
  const launched: string[] = [];
  const load = () =>
    `${running.length + launched.length} of ${config.concurrency} running, ${launchedBefore + launched.length} of ${config.maxLaunches} launched`;
  const remaining = batchRemaining(config.maxLaunches, launchedBefore);
  if (remaining === 0)
    return `${await turnOffSpent(spec, config.maxLaunches)}; ${load()}`;
  const free = Math.min(
    freeSlots(config.concurrency, running.length),
    remaining,
  );
  if (free === 0) return `${load()}; no free slot`;

  const candidates = await spec.candidates({
    sources: includedSources(spec.sources?.() ?? [], settings),
    settings,
    config,
    signal,
  });
  const [approved, withOrigin, armed] = await Promise.all([
    approvedTaskIds(spec.id),
    taskIdsWithOrigin(candidates.map((c) => c.taskId)),
    listArmedTaskIds(),
  ]);
  const picks = selectLaunches(
    candidates,
    approved,
    new Set([...withOrigin, ...armed]),
    free,
  );

  for (const pick of picks) {
    const prompt = fillPrompt(spec, settings, pick.variables);
    // Lost a race to another automation's filing or launch: not ours.
    if (!(await recordLaunch(spec.id, pick.taskId))) continue;
    await armTaskAutoStart({
      taskId: pick.taskId,
      model: settings.model,
      prompt,
      cause: `automation:${spec.id}`,
    });
    launched.push(pick.taskId);
  }
  if (launched.length > 0) automationsCatalogServed.notify();
  const spent =
    batchRemaining(config.maxLaunches, launchedBefore + launched.length) === 0
      ? `; ${await turnOffSpent(spec, config.maxLaunches)}`
      : "";
  return launched.length === 0
    ? `nothing approved to launch; ${load()}${spent}`
    : `launched ${launched.join(", ")}; ${load()}${spent}`;
}

/** Its batch is spent: turn it off, the person's own switch. */
async function turnOffSpent(
  spec: LaunchAutomationSpec,
  maxLaunches: number,
): Promise<string> {
  await setConfig(spec.config, "enabled", false, {
    writer: systemOrigin(
      `${spec.id}: launched ${maxLaunches} of ${maxLaunches}`,
    ),
  });
  return `launched its ${maxLaunches}; turned itself off`;
}

/** The automation's prompt template filled for one task — or a throw. */
function fillPrompt(
  spec: AutomationSpec,
  settings: AutomationSettings,
  variables: Readonly<Record<string, string>>,
): string {
  const prompt = renderPrompt(settings.prompt, {
    ...variables,
    pushPolicy: PUSH_POLICY_TEXT[settings.push],
  });
  if (!prompt.ok) {
    // The pane refuses such a template; this is a hand edit. Start nothing
    // rather than an agent with a hole where its evidence was.
    throw new Error(
      `automation ${spec.id}: its prompt template uses ${prompt.unknown.map((n) => `{{${n}}}`).join(", ")}, which it does not fill — fix the prompt in its config`,
    );
  }
  return prompt.text;
}

async function adoptLegacy(spec: FileAutomationSpec): Promise<void> {
  if (!spec.adoptLegacy) return;
  const adopted = await adoptAutomationTasks(spec.id, await spec.adoptLegacy());
  if (adopted > 0) {
    log.publish(`automation ${spec.id}: adopted ${adopted} legacy task(s)`);
    automationsCatalogServed.notify();
  }
}

function adoptLegacyWarmup(spec: FileAutomationSpec, jobName: string) {
  return defineWarmup({
    name: `${jobName}.adopt-legacy`,
    description: `Records the tasks "${spec.label}" filed before automations stored where a task came from.`,
    scope: "worktree",
    run: () => adoptLegacy(spec),
  });
}

/**
 * Declare an automation. It owns its job (`automation.<id>`, singleton, one
 * run at a time), which runs on the schedule its config sets — re-installed
 * live when the config changes — or, set to its event, when the handle's
 * `fire()` says so, once the burst settles.
 *
 * - **file** (default): every run reads the config, files nothing while
 *   disabled or while a task it filed is open, asks `detect` over the included
 *   sources, fills the config's prompt template, then files ONE task (category
 *   + origin row, one transaction) and arms its launch with the chosen model.
 * - **launch** (`kind: "launch"`): every run counts the slots its launched
 *   tasks hold and what is left of its batch (`maxLaunches` since it was
 *   turned on), and while both allow asks `candidates` and launches the first
 *   ones a PERSON APPROVED (`decideLaunchEndpoint`) that fit — origin row role
 *   `launched`, marker armed with the filled prompt. A spent batch turns it
 *   off. Also woken, whatever its trigger, when a task it launched settles
 *   or is released, when its config changes, and at boot.
 *
 * ```ts
 * export const depsUpgradesConfig = defineAutomationConfig("deps-upgrades", { … });
 * export const depsUpgradesAutomation = defineAutomation({
 *   id: "deps-upgrades", label: "Dependency upgrades", icon: symbol("upgrade"),
 *   description, categoryId: DEPS_CATEGORY_ID, config: depsUpgradesConfig,
 *   triggers: { kinds: ["schedule"] }, inProcess: "…",
 *   sources: () => …, promptVariables: [{ name: "outdated", description: "…" }],
 *   detect: async ({ sources, settings }) => … ?? null,
 * });
 * // register: [depsUpgradesAutomation]
 * ```
 */
export function defineAutomation<F extends LaunchAutomationConfigFields>(
  spec: LaunchAutomationSpec<F>,
): Automation;
export function defineAutomation<F extends AutomationConfigFields>(
  spec: FileAutomationSpec<F>,
): Automation;
export function defineAutomation(spec: AutomationSpec): Automation {
  // The registry holds every automation at the common shape; `detect` and
  // `candidates` are methods, so their context parameter is read bivariantly
  // there.
  const common: AutomationSpec = spec;
  const jobName = `automation.${spec.id}`;

  // The pending event-triggered run: when its burst began, and the start it
  // was last queued for. Process state — a restart forgets a burst's start,
  // which only lets that one burst wait a little longer.
  let burstStartedAt: number | null = null;
  let queuedRunAt: number | null = null;

  const job = defineJob({
    name: jobName,
    description: spec.description,
    hold: "minutes",
    inProcess: spec.inProcess,
    input: z.object({}),
    event: z.never(),
    dedup: "singleton",
    // One run at a time: a wake while a run is in flight queues the next run
    // behind it, so two runs can never both count a slot free (launch) or
    // both find no open task (file).
    serial: true,
    schedule: { cron: () => automationCron(common).cron },
    async run({ ctx }) {
      burstStartedAt = null;
      queuedRunAt = null;
      log.publish(
        `automation ${spec.id}: ${await runAutomation(common, ctx.signal)}`,
      );
    },
  });
  const adoptWarmup =
    common.kind !== "launch" && common.adoptLegacy
      ? adoptLegacyWarmup(common, jobName)
      : null;

  // Run as soon as possible, whatever the trigger: a launch-kind automation's
  // slots moved. The singleton key collapses it onto the one pending row
  // (graphile's default key mode pulls that row's start to now).
  function wake(): void {
    if (!isMain()) return;
    if (!automationSettings(common).enabled) return;
    void job.enqueue({});
  }

  return {
    id: spec.id,
    jobName,
    _kind: "automation",
    _factory: "defineAutomation",
    _doc: { label: spec.id, detail: spec.description },
    fire() {
      if (!isMain()) return;
      const settings = automationSettings(common);
      if (!settings.enabled || settings.trigger !== "event") return;
      const now = Date.now();
      const settleMs = settings.settleMinutes * 60_000;
      burstStartedAt ??= now;
      const runAt = Math.min(
        now + settleMs,
        burstStartedAt + settleMs * SETTLE_MAX_WAIT_FACTOR,
      );
      if (
        queuedRunAt !== null &&
        Math.abs(runAt - queuedRunAt) < RESCHEDULE_GRANULARITY_MS
      ) {
        return;
      }
      queuedRunAt = runAt;
      // The singleton key collapses every enqueue onto the one pending row,
      // and graphile's default key mode moves its run_at to the new start.
      void job.enqueue({}, { runAt: new Date(runAt) });
    },
    async register() {
      addAutomation({ spec: common, jobName, wake });
      await job.register();
      if (adoptWarmup !== null) await adoptWarmup.register();
    },
  };
}
