import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DraftSlots } from "@plugins/primitives/plugins/persistent-draft/web";
import { UnsavedDraftWarning } from "./components/unsaved-draft-warning";

export default {
  description:
    "Warns once per page load, with an error toast, when the browser refuses to save a draft (storage full or blocked) — the text then lives only in memory and a reload loses it.",
  contributions: [
    DraftSlots.Root({ component: UnsavedDraftWarning, companion: true }),
  ],
} satisfies PluginDefinition;
