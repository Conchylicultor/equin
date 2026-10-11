import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { watchConfig } from "@plugins/config_v2/server";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { taskStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { taskTrackChanged } from "@plugins/tasks/plugins/task-track/server";
import { automationConfigRegistration } from "@plugins/tasks/plugins/automations/server";
import { sidequestAutopilotConfig } from "../shared/config";
import { answerTriageEndpoint, retriageEndpoint } from "../shared/endpoints";
import { sidequestAutopilotAutomation } from "./internal/automation";
import { sidequestReadyJob } from "./internal/ready-job";
import { sidequestTriageServed } from "./internal/resource";
import { handleAnswerTriage, handleRetriage } from "./internal/routes";
import { runUntilJob, scheduleRunUntil } from "./internal/run-until";
import {
  backfillWhenTriageTurnsOn,
  triageBackfillJob,
  triageBackfillWarmup,
  triageJob,
  triageOnTaskJob,
} from "./internal/triage-jobs";

export default {
  description:
    "Declares the Sidequest autopilot automation (launch kind, off by default): while on, it starts agents on the ready sidequests (no attempt, not held, dropped or blocked) a person APPROVED in its launch list — best first by triage's value for size, `concurrency` at a time (default 2), at most `maxLaunches` per turn-on (default 5) — each with the autopilot prompt (triage's context and the person's answer included; never ask, check obsolescence first, stay in scope, push only what the push policy allows, finish with submit_outcome_report). Triage (on by default, main only): each ready sidequest is read once by a read-only Sonnet run (Read / Grep / Glob over the main checkout) — verdict ready / decide / split / obsolete, risk, size, value, areas, a free-form context and at most one one-click question — stored in tasks_ext_sidequest_triage and served as sidequest-autopilot.triage; queued when a task becomes a sidequest or a sidequest becomes ready, backfilled at boot, re-run only by the person's Re-triage. Triage approves nothing. Turns itself off at its `runUntil`.",
  contributions: [
    automationConfigRegistration(sidequestAutopilotConfig),
    ...sidequestTriageServed.declare,
    Trigger({
      on: taskStatusChanged.where({ status: "new" }),
      do: sidequestReadyJob,
      with: {},
      oneShot: false,
    }),
    Trigger({
      on: taskStatusChanged.where({ status: "new" }),
      do: triageOnTaskJob,
      with: {},
      oneShot: false,
    }),
    Trigger({
      on: taskTrackChanged.where({ track: "sidequest" }),
      do: triageOnTaskJob,
      with: {},
      oneShot: false,
    }),
  ],
  httpRoutes: {
    [retriageEndpoint.route]: handleRetriage,
    [answerTriageEndpoint.route]: handleAnswerTriage,
  },
  register: [
    sidequestAutopilotAutomation,
    sidequestReadyJob,
    runUntilJob,
    triageJob,
    triageOnTaskJob,
    triageBackfillJob,
    triageBackfillWarmup,
  ],
  onAllReady: () => {
    scheduleRunUntil();
    backfillWhenTriageTurnsOn();
    watchConfig(sidequestAutopilotConfig, () => {
      scheduleRunUntil();
      backfillWhenTriageTurnsOn();
    });
  },
} satisfies ServerPluginDefinition;
