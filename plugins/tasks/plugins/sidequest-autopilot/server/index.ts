import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { watchConfig } from "@plugins/config_v2/server";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { taskStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { taskTrackChanged } from "@plugins/tasks/plugins/task-track/server";
import { automationConfigRegistration } from "@plugins/tasks/plugins/automations/server";
import { sidequestAutopilotConfig } from "../shared/config";
import { sidequestAutopilotAutomation } from "./internal/automation";
import { sidequestReadyJob } from "./internal/ready-job";
import { runUntilJob, scheduleRunUntil } from "./internal/run-until";
import {
  backfillWhenTriageTurnsOn,
  triageBackfillJob,
  triageBackfillWarmup,
  triageOnTaskJob,
} from "./internal/triage-requests";

export default {
  description:
    "Declares the Sidequest autopilot automation (launch kind, off by default): while on, it starts agents on the ready sidequests (no attempt, not held, dropped or blocked) a person APPROVED — best first by triage's priority (must → should → could, then oldest filed), `concurrency` at a time (default 2), at most `maxLaunches` per turn-on (default 5) — each with the autopilot prompt (triage's context, the person's answer and their note included; never ask, check obsolescence first, stay in scope, push only what the push policy allows, finish with submit_outcome_report). Triage is task-triage's: while the `triage` toggle is on (default, main only) it asks task-triage for a read of each ready sidequest that has none — when a task becomes a sidequest or a sidequest becomes ready, backfilled at boot and when the toggle turns on. Triage approves nothing. Turns itself off at its `runUntil`.",
  contributions: [
    automationConfigRegistration(sidequestAutopilotConfig),
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
  register: [
    sidequestAutopilotAutomation,
    sidequestReadyJob,
    runUntilJob,
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
