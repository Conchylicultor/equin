import { useCallback } from "react";
import {
  DEFAULT_DRAFT_TTL,
  legacyDraftKeys,
  useDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";

/**
 * How one conversation's agents card is shown, shared by the card and the
 * agents stat in the transcript strip that toggles it.
 *
 * - `showAll` — list every agent the conversation launched, finished or not,
 *   and keep the card on screen with nothing running. Off, the card is the
 *   running-agents band: what is working now, and nothing when nothing is.
 * - `open` — the list is unfolded under the summary line.
 *
 * One localStorage-backed value per conversation: the two halves sit in
 * different slots of the pane (above the prompt box, and in the transcript's
 * overlay) with no common ancestor of their own, and `useDraft` keeps every
 * reader of one key in sync.
 */
export interface AgentsBandView {
  showAll: boolean;
  open: boolean;
}

const DEFAULT_VIEW: AgentsBandView = { showAll: false, open: true };

const bandViewStore = defineStore<AgentsBandView>({
  owner: "running-agents.view",
  label: "Agent card views",
  area: "local",
  cap: "64 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "evict-oldest",
  schema: z.object({ showAll: z.boolean(), open: z.boolean() }),
  legacy: legacyDraftKeys("running-agents:view"),
});

export function useAgentsBandView(conversationId: string): {
  view: AgentsBandView;
  setOpen: (open: boolean) => void;
  /** Show every agent, unfolded — or, when already shown, go back to the running ones. */
  toggleShowAll: () => void;
} {
  const [view, setView] = useDraft(bandViewStore, DEFAULT_VIEW, {
    scope: conversationId,
  });
  const setOpen = useCallback(
    (open: boolean) => setView((prev) => ({ ...prev, open })),
    [setView],
  );
  const toggleShowAll = useCallback(
    () =>
      setView((prev) =>
        prev.showAll
          ? { ...prev, showAll: false }
          : { showAll: true, open: true },
      ),
    [setView],
  );
  return { view, setOpen, toggleShowAll };
}
