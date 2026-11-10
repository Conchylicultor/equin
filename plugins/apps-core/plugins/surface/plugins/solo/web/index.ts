import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Surface } from "@plugins/apps-core/plugins/surface/web";
import { soloDef } from "./solo-placement";

export default {
  description:
    "Solo (fullscreen) surface mode — the default boot mode: only the focused tab, full-viewport (the tab bar and app rail hidden, the global action bar floating). Left only through the surface-mode control (no keyboard shortcut: Esc belongs to whatever is open).",
  contributions: [Surface.Placement(soloDef)],
} satisfies PluginDefinition;
