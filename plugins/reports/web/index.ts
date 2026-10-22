import { Reports } from "./slots";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { reportsConfig } from "../core";
import { IdKinds } from "@plugins/ids/web";
import { reportIdKind } from "../core";

export { report } from "./report";
export { investigate } from "./investigate";
export type { ReportContext } from "./report";
export { Reports } from "./slots";

export default {
  collapsed: true,
  description:
    "Reports uncaught browser errors to the server, and registers the reports engine's fan-out ceiling config (per-window distinct-fingerprint budget, window, storm roster cap) for Settings → Config.",
  contributions: [
    IdKinds.Kind({ kind: reportIdKind }),
    ConfigV2.WebRegister({ descriptor: reportsConfig }),
  ],
  slots: Reports,
} satisfies PluginDefinition;
