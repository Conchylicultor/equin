import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { automationConfigRegistration } from "@plugins/tasks/plugins/automations/server";
import { UPSTREAM_CATEGORY_ID, upstreamMergeConfig } from "../shared/config";
import { upstreamReminderConfig } from "../shared/reminder-config";

export default {
  description:
    "Upstream, portable half: the Upstream merges automation's config registration, the update reminders config, the Upstream task category, and the upstream_release_check table the desktop half records each check of upstream's releases in.",
  contributions: [
    automationConfigRegistration(upstreamMergeConfig),
    ConfigV2.Register({ descriptor: upstreamReminderConfig }),
    TaskCategory({ id: UPSTREAM_CATEGORY_ID, label: "Upstream", order: 12 }),
  ],
} satisfies ServerPluginDefinition;
