import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { peekFocusedTabSet } from "@plugins/apps-core/plugins/tabs/web";
import { Surface } from "@plugins/apps-core/plugins/surface/web";
import { defineShortcut } from "@plugins/primitives/plugins/shortcuts/web";
import { soloDef } from "./solo-placement";

export default {
  description:
    "Solo (fullscreen) surface mode — the default boot mode: only the focused tab, full-viewport (the tab bar and app rail hidden, the global action bar floating), with an Esc shortcut back to the previous mode.",
  contributions: [
    Surface.Placement(soloDef),
    // Esc exits solo (fullscreen) back to the mode it was entered from, in
    // the tab set the user is in — the page's, or an embed's (a demo window
    // taken full screen). The `when` self-references this mode's own id
    // (allowed — owned here).
    defineShortcut({
      id: "surface.exit-solo",
      keys: "Escape",
      label: "Exit fullscreen",
      group: "Surface",
      when: () => peekFocusedTabSet()?.mode() === "solo",
      handler: () => peekFocusedTabSet()?.exitToPreviousMode(),
    }),
  ],
} satisfies PluginDefinition;
