import { exposedColumns } from "@plugins/network/plugins/live/core";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import {
  songIdKind,
  songLibrary,
} from "@plugins/apps/plugins/sonata/plugins/library/core";
import { appLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { conversationRoute } from "@plugins/conversations/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { retryTranscription } from "../../shared/endpoints";
import { songTranscriptionShape } from "../../shared/shape";

// The run state every song row carries, folded in from the transcription
// exposure (`$columns.transcription`).
const transcription = exposedColumns(songTranscriptionShape.exposure);

function OpenConversation({ convId }: { convId: string | null }) {
  // Null only between the row's insert and the launch, which one request
  // spans; there is nothing to open yet.
  if (convId === null) return null;
  return (
    <Button
      variant="outline"
      {...appLinkProps(conversationRoute.link(agentManagerApp, { convId }))}
    >
      Open conversation
    </Button>
  );
}

/**
 * What a transcribed song shows in place of its score until the score exists:
 * read live off the song's row (the fields the transcription exposure folds in), so it follows
 * the run — transcribing (with the agent's conversation to watch or step
 * into), failed (the reason and Retry). Once the agent submits, the player
 * re-hydrates and shows the score instead.
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
      return (
        <Stack gap="md" align="start">
          <Inline gap="sm">
            <Spinner className="size-4" />
            <Text variant="body">
              An agent is reading the sheet music and writing it out. It shows
              up here when it is done.
            </Text>
          </Inline>
          <OpenConversation convId={t.conversationId} />
        </Stack>
      );
    case "failed":
      return (
        <Stack gap="md" align="start">
          <Text variant="body" tone="destructive" role="alert">
            {t.error ?? "The transcription failed."}
          </Text>
          <Inline gap="sm">
            <Button
              onClick={async () => {
                await fetchEndpoint(retryTranscription, { id: songId });
              }}
            >
              Retry
            </Button>
            <OpenConversation convId={t.conversationId} />
          </Inline>
        </Stack>
      );
    case "ready":
    case null:
      // The player re-hydrates on the same row change that made it ready;
      // until then this is the moment between the two.
      return <Loading />;
  }
}
