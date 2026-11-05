import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { bootWatchdogConfig } from "../core";
import { bootWedgeKind } from "./internal/boot-wedge-kind";

export default {
  description:
    "Boot-watchdog, every host's half: registers the boot-watchdog config (budget, lookback) and the boot-wedge report kind. The monitor that files the reports is the machine/ half's.",
  contributions: [
    ConfigV2.Register({ descriptor: bootWatchdogConfig }),
    bootWedgeKind,
  ],
} satisfies ServerPluginDefinition;
