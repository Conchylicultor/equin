import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  InlineChip,
  inlineChip,
} from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/web";
import { UI_CONTEXT_RE } from "@plugins/primitives/plugins/ui-context/core";
import { UiContextTag } from "./components/ui-context-tag";
// Side-effect: stamps every slot contribution with its lineage. Opt-in on
// purpose — see the module — so it rides this barrel, never the parent's.
import { SlotRender } from "@plugins/primitives/plugins/slot-render/web";
import {
  markerAttrs,
  PluginMarkerMiddleware,
} from "./internal/marker-middleware";

export { ElementPicker } from "./components/element-picker";
export type { ElementPickerProps } from "./components/element-picker";
export { PickerButton } from "./components/picker-button";

export default {
  description:
    "Chrome-inspector-style element picker: <ElementPicker> arms a full-screen overlay, the user hovers and clicks any element, and onPick receives its <ui-context> metadata (plugin/slot lineage, selector, source). Also declares the <ui-context> inline chip, so whatever can make the token can display it, and stamps every slot contribution with its lineage while in the composition.",
  contributions: [
    // The ONE registration of the `<ui-context>` chip. It lives with the picker
    // because a plugin enters a composition only through an import: whoever can
    // make the token must be able to draw it, with or without active-data.
    InlineChip.Tag(
      inlineChip({
        id: "ui-context",
        pattern: UI_CONTEXT_RE,
        // TRANSCRIPT ONLY. A `<ui-context>` tag is a pointer at a live UI
        // element captured for one agent turn — it is addressed to the model
        // reading that draft or conversation, and means nothing in a page a
        // person wrote.
        surfaces: ["transcript"],
        modelText: "self-describing",
        component: UiContextTag,
      }),
    ),
    // Stamp every slot contribution with its lineage — opt-in (not companions):
    // the cost is paid only where something that can pick is in the composition.
    SlotRender.ItemAttrs({ attrs: markerAttrs }),
    SlotRender.ItemMiddleware({
      priority: 50,
      Component: PluginMarkerMiddleware,
    }),
  ],
} satisfies PluginDefinition;
