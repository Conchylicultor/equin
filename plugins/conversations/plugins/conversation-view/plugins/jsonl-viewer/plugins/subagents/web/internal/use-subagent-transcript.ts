import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  mapResource,
  type ResourceResult,
  type ResourceUnavailable,
} from "@plugins/primitives/plugins/live-state/web";
import {
  transcriptWindowOf,
  type TranscriptWindow,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import {
  subagentTranscript,
  type SubagentRef,
  type SubagentTranscriptMeta,
} from "../../core";

/**
 * A sub-agent's transcript as its pane draws it: linked, its loaded window
 * (`TranscriptView`'s `events` / `ids` / `firstSeq` / `older`) and the last
 * write-up it handed back; otherwise the settled reason there is nothing to
 * draw (`unlinked` / `unjoinable`).
 */
export type SubagentTranscriptView =
  | {
      kind: "linked";
      agentId: string;
      /** The last `SubagentHandback` message, over the WHOLE transcript. */
      handback: string | null;
      window: TranscriptWindow;
    }
  | Exclude<SubagentTranscriptMeta, { kind: "linked" }>;

/**
 * One sub-agent's transcript: its latest events, older ones loading on
 * `window.older.loadMore()`, read as the conversation's own is
 * (`useTranscriptWindow`) — never the whole array at once. Drawn once the
 * pages and the meta (the link state, and what only the whole transcript
 * knows) have both landed. `unavailable` under a host without the computer.
 */
export function useSubagentTranscript(
  conversationId: string,
  subagent: SubagentRef,
): ResourceResult<SubagentTranscriptView> | ResourceUnavailable {
  const query = { id: conversationId, by: subagent.by, key: subagent.key };
  const rows = useLive(subagentTranscript, query);
  const meta = useLive(subagentTranscript.meta, query);
  return useMemo(
    () =>
      mapResource(
        combineResources({ rows, meta }),
        (data): SubagentTranscriptView => {
          if (data.meta.kind !== "linked") return data.meta;
          return {
            kind: "linked",
            agentId: data.meta.agentId,
            handback: data.meta.handback,
            window: transcriptWindowOf(
              // Ready here: the combine is ready only when every input is.
              rows.status === "unavailable" ? never(rows) : rows,
              data.rows,
              data.meta.firstAssistantSeq,
              data.meta.prompts,
            ),
          };
        },
      ),
    [rows, meta],
  );
}

function never(rows: ResourceUnavailable): never {
  throw new Error(
    `[subagents] a ready transcript combine read unavailable pages: ${rows.message}`,
  );
}
