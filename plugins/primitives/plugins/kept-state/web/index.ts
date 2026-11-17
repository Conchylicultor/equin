import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useDraft } from "./use-draft";
export type { KeptBinding, KeptHandle } from "./use-draft";
export { useKept } from "./use-kept";
export { defineKept } from "./define-kept";
export type {
  KeptView,
  KeptViewSpec,
  KeptWork,
  KeptWorkSpec,
} from "./define-kept";
export { forgetKeepScope, KeepScope, useKeepScope } from "./keep-scope";
export { submitKept } from "./submit-kept";
export type { SubmitShows } from "./submit-kept";
export {
  clearDraft,
  DEFAULT_DRAFT_TTL,
  flushKept,
  legacyDraftKeys,
  onDraftWritten,
  readDraft,
  writeDraft,
} from "./draft-storage";
export type { DraftOptions, DraftWrite } from "./draft-storage";

export default {
  description:
    "Kept state: what a reload, a tab switch or an upgrade must give back. defineKept declares a piece of it in one of two tiers — work (what the user made and the server does not have yet: its own local store, refused when full, one entry per subject) or view (where the user was looking: one pooled session store, keyed by the ambient KeepScope — the pane instance, else the tab — and dropped when that place closes, forgetKeepScope) — and useKept reads it as a useState drop-in. useDraft is the same over a store the caller declared (defineStore). Writes are batched to the end of the frame and flushed on pagehide (flushKept). submitKept clears work only once its send is taken, so a reload between the click and the ack keeps it. readDraft/writeDraft are the render-free twin for callers writing at input frequency; onDraftWritten(scope, listener) observes every write and clear in one composition scope; legacyDraftKeys carries drafts written before web-storage into a store.",
  contributions: [],
} satisfies PluginDefinition;
