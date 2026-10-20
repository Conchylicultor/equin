import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  readyResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { useJsonlConversationId } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { foldEvents, type TranscriptFold } from "../core";
import { useTranscriptRead } from "./read-context";

/**
 * A stat's fold of the transcript up to the reading position. The events the
 * page holds are folded here; the ones before them (a long conversation opens
 * on its latest events) come folded from the server (`fold.before`, served by
 * `serveTranscriptFold`) — loading until they have.
 */
export function useTranscriptFold<S>(
  fold: TranscriptFold<S>,
): ResourceResult<S> {
  const { events, firstSeq } = useTranscriptRead();
  const conversationId = useJsonlConversationId();
  const needsBase = firstSeq > 0;
  if (needsBase && conversationId === null) {
    throw new Error("a transcript window is drawn outside its conversation");
  }
  const base = useLive(
    fold.before,
    needsBase && conversationId !== null
      ? { id: conversationId, before: String(firstSeq) }
      : null,
  );
  return useMemo((): ResourceResult<S> => {
    if (!needsBase) return readyResource(foldEvents(fold, fold.init(), events));
    return mapResource(base, (state) => foldEvents(fold, state, events));
  }, [needsBase, base, fold, events]);
}
