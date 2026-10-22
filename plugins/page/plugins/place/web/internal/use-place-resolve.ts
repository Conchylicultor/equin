import { useEffect, useRef, useState } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  placeNeedsResolve,
  placeResolve,
  type PlaceData,
  type PlaceSnapshot,
} from "../../core";

export interface UsePlaceResolveArgs {
  providerId: string | undefined;
  placeId: string | undefined;
  /**
   * The block's stored snapshot fields. The hook — not the caller — decides
   * whether they need refreshing, because that decision reads the clock and a
   * component may not do that while rendering.
   */
  snapshot: Pick<PlaceData, "name" | "fetchedAt">;
  /** The current search-round token, handed to the provider with the request. */
  session: string;
  /**
   * Called once per answer, with the provider that answered and its answer. The
   * provider id is handed BACK rather than re-read by the caller: it is the id
   * this hook actually asked, so the write can never stamp a snapshot with a
   * different one, and the caller needs no non-null assertion to name it.
   * The caller ends the round (a new `session`), so the next ask is a new
   * question.
   */
  onResolved: (providerId: string, snapshot: PlaceSnapshot) => void;
}

export interface PlaceResolveState {
  /** The provider's reason the last resolve failed, or null. */
  error: string | null;
  /** A resolve is in flight right now. */
  refreshing: boolean;
  /**
   * Ask the provider again now, whether or not the snapshot is due — the card's
   * Refresh action, and the retry after a failure.
   */
  refresh: () => void;
}

/** The question being asked: the read's params, or `null` while nothing is. */
type ResolveQuestion = { providerId: string; placeId: string; session: string };

/**
 * Resolve one place, at most once per place (or once per `refresh`). Called
 * UNCONDITIONALLY from every render state — the hook itself decides whether
 * there is anything to ask — so the block's three states share one hook order.
 *
 * The ask is a `place.resolve` read held only while there is a question; the
 * answer is handed to `onResolved` (which copies it into the block) and the
 * read is dropped. The returned `error` is rendered by the caller and never
 * swallowed: a provider that could not answer is a card that says so, next to
 * whatever snapshot it already had.
 */
export function usePlaceResolve({
  providerId,
  placeId,
  snapshot,
  session,
  onResolved,
}: UsePlaceResolveArgs): PlaceResolveState {
  const [question, setQuestion] = useState<ResolveQuestion | null>(null);
  // Bumped by `refresh`: a dep of the deciding effect, so a refresh re-runs it.
  const [attempt, setAttempt] = useState(0);
  // Set by `refresh`, consumed by the effect run it triggers: the one ask that
  // goes out although the snapshot is still fresh.
  const forceRef = useRef(false);
  // The place the current question is about. The round ends (a new `session`)
  // in the same update that writes the answer; should the snapshot land a
  // render later, that new session must not ask about the same place again.
  const askedRef = useRef<string | null>(null);

  const { name, fetchedAt } = snapshot;

  useEffect(() => {
    // The clock is read HERE, inside the effect, and never during render: "is
    // this snapshot expired" is a question about `now`, and a component that
    // asks it while rendering produces a different answer depending on when
    // React happens to re-render it. The honest trade is that a snapshot which
    // expires while the page sits open refreshes on the next mount or edit
    // rather than mid-view — a month-old address is not worth a render-loop.
    const needsResolve =
      forceRef.current || placeNeedsResolve({ name, fetchedAt }, Date.now());
    if (!needsResolve || providerId === undefined || placeId === undefined) {
      // Nothing to ask right now. It cannot loop: a successful resolve stamps
      // `fetchedAt`, which keeps this branch taken for the whole TTL.
      askedRef.current = null;
      setQuestion(null);
      return;
    }
    if (!forceRef.current && askedRef.current === placeId) return;
    askedRef.current = placeId;
    forceRef.current = false;
    // One tuple per (place, round): a re-run with the same values asks the same
    // question again — the read is shared, never a second request — and a
    // failed one stays failed until `refresh` or a replaced place.
    setQuestion({ providerId, placeId, session });
  }, [name, fetchedAt, providerId, placeId, session, attempt]);

  const read = useLive(placeResolve, question);

  // Hand each answer over exactly once (a re-render with the same answer does
  // not write the block again).
  const handedRef = useRef<PlaceSnapshot | null>(null);
  useEffect(() => {
    if (question === null) return;
    if (read.status === "ready" && handedRef.current !== read.data) {
      handedRef.current = read.data;
      onResolved(question.providerId, read.data);
    }
  }, [question, read, onResolved]);

  function refresh() {
    // A failed question is asked again as the same question (the provider's
    // answer may have changed: a rate limit passed, a key added); otherwise a new
    // ask of the current round.
    if (question !== null && read.status === "error") {
      void read.refetch();
      return;
    }
    forceRef.current = true;
    setAttempt((n) => n + 1);
  }

  return {
    error:
      question !== null && read.status === "error" ? read.error.message : null,
    refreshing: question !== null && read.status === "loading",
    refresh,
  };
}
