import { exposedColumns } from "@plugins/network/plugins/live/core";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import {
  songIdKind,
  songLibrary,
} from "@plugins/apps/plugins/sonata/plugins/library/core";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { retryTranscription } from "../../shared/endpoints";
import { TranscriptionThread } from "./transcription-thread";
import { songTranscriptionShape } from "../../shared/shape";

// The run state every song row carries, folded in from the transcription
// exposure (`$columns.transcription`).
const transcription = exposedColumns(songTranscriptionShape.exposure);

/** The thread's height in the player's pending pane: room for the run and its reply box. */
const PENDING_THREAD_HEIGHT = "min(40rem, 75vh)";

/**
 * What a transcribed song shows in place of its score until the score exists:
 * read live off the song's row (the fields the transcription exposure folds
 * in), so it follows the run. Once the run has a conversation it is the
 * agent's thread — its steps, its summary, a reply box, Open conversation, and
 * Retry when it failed. Once the agent submits, the player re-hydrates and
 * shows the score instead (the thread moves to the player's Transcription
 * section).
 */
export function TranscriptionBody({ songId }: { songId: string }) {
  const song = useLiveRow(songLibrary, songIdKind.key(songId));
  if (song.status === "loading") return <Loading />;
  if (song.status === "error") {
    return (
      <Text variant="caption" tone="destructive" role="alert">
        {song.error.message}
      </Text>
    );
  }
  if (!song.found) {
    return (
      <Text variant="caption" tone="muted">
        This song no longer exists.
      </Text>
    );
  }
  const t = transcription.read(song.row);
  switch (t.status) {
    case "transcribing":
    case "failed":
      if (t.conversationId !== null) {
        return (
          <TranscriptionThread
            songId={songId}
            conversationId={t.conversationId}
            failed={t.status === "failed"}
            height={PENDING_THREAD_HEIGHT}
            titled={true}
          />
        );
      }
      // No conversation yet: the agent is starting, or its launch failed.
      return t.status === "transcribing" ? (
        <Inline gap="sm">
          <Spinner className="size-4" />
          <Text variant="body">
            Waiting for the transcribing agent to start.
          </Text>
        </Inline>
      ) : (
        <Stack gap="md" align="start">
          <Text variant="body" tone="destructive" role="alert">
            {t.error ?? "The transcription failed."}
          </Text>
          <Button
            onClick={async () => {
              await fetchEndpoint(retryTranscription, { id: songId });
            }}
          >
            Retry
          </Button>
        </Stack>
      );
    case "ready":
    case null:
      // The player re-hydrates on the same row change that made it ready;
      // until then this is the moment between the two.
      return <Loading />;
  }
}
