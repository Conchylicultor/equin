import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { rowActionsAnchor } from "@plugins/primitives/plugins/row-actions/web";
import { JsonlViewer } from "../slots";
import { EventActionProvider } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { eventKey } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import { RowMarkdownProvider } from "./row-markdown-context";
import { HostedContextProvider, type ContextMember } from "./hosted-context";

/**
 * `data-event-key` is content identity and is what anything remembering a row
 * across time must use. `data-event-index` remains only as a positional handle
 * for same-render lookups — it is the index into the *filtered* array, so it
 * names a different row whenever the EventFilter set changes.
 *
 * `hosted`: the context run folded into this row (its renderer declared
 * `hostsContext`), handed to the renderer through `useHostedContext()`.
 */
export function EventRow({
  event,
  index,
  hosted,
}: {
  event: JsonlEvent;
  index: number;
  hosted?: readonly ContextMember[];
}) {
  const dispatch = <JsonlViewer.EventRenderer.Dispatch event={event} />;
  return (
    <EventActionProvider event={event}>
      <RowMarkdownProvider>
        <div
          className={rowActionsAnchor}
          data-event-index={index}
          data-event-key={eventKey(event)}
        >
          {hosted ? (
            <HostedContextProvider members={hosted}>
              {dispatch}
            </HostedContextProvider>
          ) : (
            dispatch
          )}
        </div>
      </RowMarkdownProvider>
    </EventActionProvider>
  );
}
