import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { Notifications } from "@plugins/shell/plugins/notifications/web";
import { automationConfigContributions } from "@plugins/tasks/plugins/automations/web";
import { upstreamMergeConfig } from "../shared/config";
import { upstreamReminderConfig } from "../shared/reminder-config";
import { UpdatesActions, UpdateGlance } from "./components/updates-row";
import { updateReminderAction } from "./components/reminder-action";
import { ReleasesGlance } from "./components/releases-row";
import { useUpdatesHealth } from "./internal/use-updates";
import { useReleasesHealth } from "./internal/use-releases";

export default {
  description:
    "Registers the Upstream merges automation's config (schedule, push policy, model, prompt template) for the Automations pane and Settings → Config. The health report's updates row on a clone: titled by its state — 'equin is out of date' (2026.10.30 → 2026.11.14; ok — being behind is not a problem, so neither the row nor the dot is coloured) with a Send agent to update action (the launch popover, filed about the release so it is never filed twice), 'Update in progress' with the merging conversation linked beside its own status chip (pulsing while it works, attention while it waits on the user), 'Installing' while main rebuilds the merged release, then 'equin is up to date'; a reminder bell in every state (the update reminders config). The update reminder's action (equin-update) on the 'equin is out of date' notification the daily check writes: Send agent to update (the row's launch popover) and Remind me later (Tomorrow / In a week / In a month / Skip this release / Never), each settling the notification. Absent on the canonical repo, before any check, and where upstream has cut no release. On the canonical repo's main instead, the 'equin releases' row (always ok — unreleased commits are the normal state): the newest release and when it was cut, the commits on main since it, and a Release <next tag> button that runs `./equin version cut` through main's backend — disabled, with the reason on the commit line, while main builds, when its build of the served commit failed (with Open build), or when the served commit cannot be released for another reason the cut would give.",
  contributions: [
    ...automationConfigContributions(upstreamMergeConfig),
    ConfigV2.WebRegister({ descriptor: upstreamReminderConfig }),
    HealthReport.Row({
      kind: "status",
      id: "updates",
      title: "Updates",
      useStatus: useUpdatesHealth,
      glance: UpdateGlance,
      actions: UpdatesActions,
    }),
    // The checkout that publishes releases: what is unreleased, and Release.
    HealthReport.Row({
      kind: "status",
      id: "releases",
      title: "Releases",
      useStatus: useReleasesHealth,
      glance: ReleasesGlance,
    }),
    // The update reminder's Send agent / Remind me later (`equin-update`).
    Notifications.Action(updateReminderAction),
  ],
} satisfies PluginDefinition;
