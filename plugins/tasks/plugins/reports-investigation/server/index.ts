import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { automationConfigRegistration } from "@plugins/tasks/plugins/automations/server";
import { reportInvestigationsConfig } from "../shared/config";
import {
  REPORTS_CATEGORY_ID,
  registerReportsInvestigation,
} from "./internal/register";
import { reportInvestigationsAutomation } from "./internal/automation";
import { reportInvestigationsScopeServed } from "./internal/scope";

export default {
  description:
    "Files reports' investigation tasks: owns the Reports task category, registers the task-creating handler into reports' investigation sink (Investigate), and declares the Report investigations automation (off by default) — woken when a report nobody investigated is recorded (once the burst settles) or on a schedule, it files ONE task for the batch of in-scope reports (severity, recurrence, kind), links them to it, and launches an agent to find and fix the root cause.",
  contributions: [
    TaskCategory({ id: REPORTS_CATEGORY_ID, label: "Reports", order: 4 }),
    automationConfigRegistration(reportInvestigationsConfig),
    ...reportInvestigationsScopeServed.declare,
  ],
  register: [reportInvestigationsAutomation],
  onReady: () => {
    registerReportsInvestigation(() => reportInvestigationsAutomation.fire());
  },
} satisfies ServerPluginDefinition;
