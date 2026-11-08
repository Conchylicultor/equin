import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { eventField, Trigger } from "@plugins/infra/plugins/events/server";
import { blocksChanged } from "@plugins/page/plugins/editor/server";
import { autoIconJob } from "./internal/auto-icon-job";
import {
  autoIconsBackfillWarmup,
  backfillAutoIconsJob,
} from "./internal/backfill";
import { handleRegeneratePageIcon } from "./internal/routes";
import { regeneratePageIcon } from "../shared/endpoints";

export default {
  description:
    "Auto-generated page emoji icons, desktop-only half (a Haiku call through the Claude CLI): once a page's edits settle (10 s after the last blocksChanged), Haiku picks an emoji from its title + content, avoiding its siblings' icons, and writes it only if the page still has none, recording the run in the server half's page_blocks_ext_auto_icon; Regenerate (needsMachine) forces a new pick; a boot backfill covers existing pages.",
  register: [autoIconJob, backfillAutoIconsJob, autoIconsBackfillWarmup],
  httpRoutes: {
    [regeneratePageIcon.route]: handleRegeneratePageIcon,
  },
  contributions: [
    Trigger({
      on: blocksChanged,
      do: autoIconJob,
      with: { pageId: eventField("pageId") },
      oneShot: false,
    }),
  ],
} satisfies MachinePluginDefinition;
