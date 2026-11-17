import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { mainSlotsConfig } from "../shared/config";

export default {
  description:
    "Main's per-commit slots: every app main serves (its own and its compositions) runs from a checkout of the commit it was built from, apps built together share one, and one free slot is kept ready (see the plugin's core and cli). Web half: registers the main-slots config (drainReportAfterSec — how long a process may keep an old slot busy after its app switched away before it is reported) for Settings → Config.",
  contributions: [ConfigV2.WebRegister({ descriptor: mainSlotsConfig })],
} satisfies PluginDefinition;
