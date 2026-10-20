import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useDraft } from "./use-draft";
export {
  clearDraft,
  DEFAULT_DRAFT_TTL,
  legacyDraftKeys,
  onDraftWritten,
  readDraft,
  writeDraft,
} from "./draft-storage";
export type { DraftOptions, DraftWrite } from "./draft-storage";

export default {
  description:
    "Drafts over a web-storage store: useDraft is the reactive useState drop-in (all calls on one store and scope stay in sync within and across tabs); readDraft/writeDraft are the render-free imperative twin for callers writing at input frequency; onDraftWritten observes every write and clear in the tab; legacyDraftKeys carries drafts written before web-storage into a store. The store (defineStore) owns the cap, TTL and loud refusal.",
  contributions: [],
} satisfies PluginDefinition;
