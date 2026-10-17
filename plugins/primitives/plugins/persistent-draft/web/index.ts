import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useDraft } from "./use-draft";
export {
  clearDraft,
  DEFAULT_DRAFT_TTL,
  draftKey,
  onDraftWritten,
  readDraft,
  writeDraft,
} from "./draft-storage";
export type { DraftOptions, DraftWrite } from "./draft-storage";

export default {
  description:
    "Generic localStorage-backed persistence with optional entity scope and TTL auto-expiry: useDraft is the reactive useState drop-in (all calls on one key stay in sync within and across tabs); readDraft/writeDraft are the render-free imperative twin for callers writing at input frequency; onDraftWritten observes every write and clear in the tab.",
  contributions: [],
} satisfies PluginDefinition;
