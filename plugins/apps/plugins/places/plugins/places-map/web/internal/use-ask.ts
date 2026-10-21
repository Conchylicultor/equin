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
  /** The run the panel shows as a thread; null — the panel is the search. */
  conversationId: string | null;
  /** Why a question cannot be asked now; null when it can. */
  blocked: string | null;
  /** Launch a run for `question`; resolves whether it started. */
  start: (question: string) => Promise<boolean>;
  /** Back to the search; the run goes on in the background. */
  close: () => void;
}

/**
 * Ask Sonnet on the Places screen: the run the panel shows, starting one (a
 * task in the Places category, under the `places.ask` profile, on Sonnet,
 * biased to the map's view), and — once per load — reopening the newest run
 * when it is still working or said something you have not seen, so a reload
 * mid-run keeps its pill. A run you have read and closed stays closed.
 */
export function useAsk(bounds: MapBounds | null): AskState {
  const [conversationId, setConversationId] = useState<string | null>(null);
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
      // Nothing to reopen from a read that failed; the run is still in the
      // Agent Manager.
      setRestored(true);
    }
  }

  const blocked = !availability.available
    ? availability.message
    : bounds === null
      ? "Waiting for the map"
      : null;

  const start = async (question: string): Promise<boolean> => {
    if (bounds === null) return false;
    const input: PlacesAskInput = {
      bounds: biasOf(bounds),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      askedAt: new Date().toISOString(),
    };
    const result = await startThread({
      title: `Ask Sonnet: ${question}`,
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
    setRestored(true);
    setConversationId(result.value.conversationId);
    return true;
  };

  return {
    conversationId,
    blocked,
    start,
    close: () => setConversationId(null),
  };
}
