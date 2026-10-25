import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActiveData } from "@plugins/active-data/web";
import { ShowMeBlock, ShowMeInline } from "./components/show-me-chip";

export default {
  description:
    'Renders <show-me path="…" element="…">label</show-me> in an agent\'s reply — an element of the live page named by its ui-context lineage path and element descriptor (an outline entry) — as a target chip: a click resolves it on the page now (resolveUiContext) and highlights it — a pulsing ring with the label as caption, non-modal, gone after a few seconds or at the next click (hints pointAt); when nothing on the page matches, the chip says "Not on this page" (a toast, then its own look) and nothing is highlighted. One step at a time.',
  contributions: [
    ActiveData.Tag({
      display: "block",
      tag: "show-me",
      component: ShowMeBlock,
      inline: ShowMeInline,
    }),
  ],
} satisfies PluginDefinition;
