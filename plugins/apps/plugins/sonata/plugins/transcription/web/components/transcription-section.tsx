import { exposedColumns } from "@plugins/network/plugins/live/core";
import { useCurrentSong } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { songTranscriptionShape } from "../../shared/shape";
import { TranscriptionThread } from "./transcription-thread";

const transcription = exposedColumns(songTranscriptionShape.exposure);

/** The thread's height in the section column, beside the score. */
const SECTION_THREAD_HEIGHT = "min(32rem, 60vh)";

/** The open song's transcription conversation, when it was transcribed and its run has started. */
function useTranscriptionConversation():
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "none" }
  | { kind: "run"; songId: string; conversationId: string; failed: boolean } {
  const song = useCurrentSong();
  if (song.status === "loading") return { kind: "loading" };
  if (song.status === "error")
    return { kind: "error", message: song.error.message };
  if (!song.found) return { kind: "none" };
  const t = transcription.read(song.row);
  if (t.status === null || t.conversationId === null) return { kind: "none" };
  return {
    kind: "run",
    songId: song.row.id,
    conversationId: t.conversationId,
    failed: t.status === "failed",
  };
}

/** The section shows for a transcribed song once its run has a conversation. */
export function useTranscriptionSectionAvailable(): boolean {
  return useTranscriptionConversation().kind === "run";
}

/**
 * The player's Transcription section: the agent run that wrote this song's
 * score, as a thread you reply to — "bar 12 is wrong" — once the score is in.
 * The agent fixes and resubmits, and the score is replaced in place.
 */
export function TranscriptionSection() {
  const c = useTranscriptionConversation();
  switch (c.kind) {
    case "loading":
      return <Loading />;
    case "error":
      return (
        <Text variant="caption" tone="destructive" role="alert">
          {c.message}
        </Text>
      );
    case "none":
      return null;
    case "run":
      return (
        <TranscriptionThread
          songId={c.songId}
          conversationId={c.conversationId}
          failed={c.failed}
          height={SECTION_THREAD_HEIGHT}
          titled={false}
        />
      );
  }
}
