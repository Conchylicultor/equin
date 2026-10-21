import { useState } from "react";
import type { MapBounds } from "@plugins/map/core";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  useStartThread,
  useThreadProgress,
  useThreadRuns,
} from "@plugins/conversations/plugins/agent-thread/web";
import {
  PLACES_ASK_PROFILE,
  PLACES_CATEGORY_ID,
  placesPicks,
  type PlacesAskInput,
} from "@plugins/apps/plugins/places/plugins/ask/core";
import { biasOf } from "./use-google-search";

const RESULTS = [placesPicks];

/** Ask Sonnet's state on the Places screen — see {@link useAsk}. */
export interface AskState {
  /**
   * The run the side card holds (shown or hidden — its pill stays in the bar
   * either way); null — no run in hand, no card, no pill.
   */
  conversationId: string | null;
  /** The side card is on screen (else only its pill is). */
  shown: boolean;
  /** Why a question cannot be asked now; null when it can. */
  blocked: string | null;
  /** Launch a run for `question` and show it; resolves whether it started. */
  start: (question: string) => Promise<boolean>;
  /** Show run `conversationId` in the side card (from the history). */
  open: (conversationId: string) => void;
  /** The pill: show the card, or hide it. */
  toggle: () => void;
  /** Hide the card; the run stays in hand (its pill) and goes on. */
  hide: () => void;
  /** The run was ended (Done): no card, no pill — it stays in the history. */
  release: () => void;
}

/**
 * Ask Sonnet on the Places screen: the run the side card holds and whether it
 * is shown, starting one (a task in the Places category, under the
 * `places.ask` profile, on Sonnet, biased to the map's view), and — once per
 * load — taking back the newest run when it is still working or said
 * something you have not seen, HIDDEN, so a reload mid-run keeps its pill
 * (with its dot) without covering the map. A run you have read is left in the
 * history.
 */
export function useAsk(bounds: MapBounds | null): AskState {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [restored, setRestored] = useState(false);
  const { start: startThread, availability } = useStartThread({
    profile: PLACES_ASK_PROFILE,
    categoryId: PLACES_CATEGORY_ID,
    model: "sonnet",
  });

  // The restore: the newest run's progress, read until it is decided.
  const runs = useThreadRuns(PLACES_ASK_PROFILE, { limit: 1 });
  const newest =
    runs.status === "ready" ? (runs.data[0]?.id ?? null) : undefined;
  const progress = useThreadProgress(
    restored || newest === undefined ? null : newest,
    RESULTS,
  );
  if (!restored && newest !== undefined) {
    if (newest === null) {
      setRestored(true);
    } else if (progress.status === "ready") {
      setRestored(true);
      const p = progress.data;
      if (p !== null && (p.state === "working" || p.unseen))
        setConversationId(newest);
    } else if (progress.status === "error") {
      // Nothing to take back from a read that failed; the run is still in
      // the history and the Agent Manager.
      setRestored(true);
    }
  }

  const blocked = !availability.available
    ? availability.message
    : bounds === null
      ? "Waiting for the map"
      : null;

  const open = (id: string) => {
    // A run picked by hand settles the restore: it must not take over.
    setRestored(true);
    setConversationId(id);
    setShown(true);
  };

  const start = async (question: string): Promise<boolean> => {
    if (bounds === null) return false;
    const input: PlacesAskInput = {
      bounds: biasOf(bounds),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      askedAt: new Date().toISOString(),
    };
    const result = await startThread({
      title: `${ASK_TITLE_PREFIX}${question}`,
      prompt: question,
      input,
    });
    if (result.kind !== "ok") {
      showToast({
        title: "Sonnet can't be asked",
        description: result.message,
      });
      return false;
    }
    open(result.value.conversationId);
    return true;
  };

  return {
    conversationId,
    shown: shown && conversationId !== null,
    blocked,
    start,
    open,
    toggle: () => setShown((s) => !s),
    hide: () => setShown(false),
    release: () => {
      setShown(false);
      setConversationId(null);
    },
  };
}

/** How a run's task is titled: this, then the question. */
const ASK_TITLE_PREFIX = "Ask Sonnet: ";

/** The question a run was asked, read back from its title. */
export function questionOfTitle(title: string): string {
  return title.startsWith(ASK_TITLE_PREFIX)
    ? title.slice(ASK_TITLE_PREFIX.length)
    : title;
}
