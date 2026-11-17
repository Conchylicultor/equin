import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { Notifications } from "@plugins/shell/plugins/notifications/web";
import { automationConfigContributions } from "@plugins/tasks/plugins/automations/web";
import { upstreamMergeConfig } from "../shared/config";
import { upstreamReminderConfig } from "../shared/reminder-config";
import {
  ReminderBell,
  SendAgentToUpdate,
  UpdateGlance,
} from "./components/updates-row";
import { updateReminderAction } from "./components/reminder-action";
import { useUpdatesHealth } from "./internal/use-updates";

export default {
  description:
    "Registers the Upstream merges automation's config (schedule, push policy, model, prompt template) for the Automations pane and Settings → Config. The health report's updates row on a clone: titled by its state — 'equin is out of date' (2026.10.30 → 2026.11.14; drawn as attention but ambient, so the dot stays green) with a Send agent to update remedy (the launch popover, filed about the release so it is never filed twice), 'Update in progress' with the merging conversation linked beside its own status chip (pulsing while it works, attention while it waits on the user), 'Installing' while main rebuilds the merged release, then 'equin is up to date'; a reminder bell in every state (the update reminders config). The update reminder's action (equin-update) on the 'equin is out of date' notification the daily check writes: Send agent to update (the row's launch popover) and Remind me later (Tomorrow / In a week / In a month / Skip this release / Never), each settling the notification. Absent on the canonical repo, before any check, and where upstream has cut no release.",
  contributions: [
    ...automationConfigContributions(upstreamMergeConfig),
    ConfigV2.WebRegister({ descriptor: upstreamReminderConfig }),
    HealthReport.Row({
      kind: "status",
      id: "updates",
      title: "Updates",
      useStatus: useUpdatesHealth,
      glance: UpdateGlance,
      actions: ReminderBell,
      remedy: SendAgentToUpdate,
    }),
    // The update reminder's Send agent / Remind me later (`equin-update`).
    Notifications.Action(updateReminderAction),
  ],
} satisfies PluginDefinition;
