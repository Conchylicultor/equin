import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { AgentThread } from "@plugins/conversations/plugins/agent-thread/web";
import { transcriptionScore } from "../../core";
import { retryTranscription } from "../../shared/endpoints";

const RESULTS = [transcriptionScore];

const transcriptionIcon = symbol("music-note");
const scoreIcon = symbol("check-circle");

export interface TranscriptionThreadProps {
  songId: string;
  conversationId: string;
  /** The run failed (closed before a score): the header offers Retry, a fresh run. */
  failed: boolean;
  /** The thread's height: it fills this box. */
  height: string;
  /** Name the thread in its header — not where a section header already does. */
  titled: boolean;
}

/**
 * A transcription's agent run as an embedded thread: the request, the agent's
 * steps (renders, side-by-side comparisons), its summary, each accepted score
 * as a "Score in" line — and a reply box, so the user asks for a correction
 * ("bar 12 is wrong") right here; the agent fixes, resubmits, and the song's
 * score is replaced in place.
 */
export function TranscriptionThread({
  songId,
  conversationId,
  failed,
  height,
  titled,
}: TranscriptionThreadProps) {
  const fetchEndpoint = useFetchEndpoint();
  return (
    <div style={{ height }}>
      <AgentThread
        conversationId={conversationId}
        results={RESULTS}
        title={
          titled && (
            <Line className="gap-2xs">
              <Icon icon={transcriptionIcon} className="size-4" />
              <Text variant="label" tone="strong">
                Transcription
              </Text>
            </Line>
          )
        }
        resultWords={(n) => (n === 1 ? "score in" : `${n} scores`)}
        headerAction={
          failed ? (
            <Button
              onClick={async () => {
                await fetchEndpoint(retryTranscription, { id: songId });
              }}
            >
              Retry
            </Button>
          ) : undefined
        }
        placeholder="Reply — e.g. bar 12 is wrong"
        renderResult={(result, { latest }) =>
          latest ? (
            <Line className="gap-2xs">
              <Icon icon={scoreIcon} className="size-4" />
              <Text variant="label" tone="strong">
                Score in
              </Text>
              <Text variant="caption" tone="muted">
                {result.payload.path}
              </Text>
            </Line>
          ) : (
            <Text variant="caption" tone="muted">
              Earlier version · {result.payload.path}
            </Text>
          )
        }
      />
    </div>
  );
}
