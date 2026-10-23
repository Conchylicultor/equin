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
 *
 * `standIn`: the event is not in the transcript yet — a sent turn's echo
 * (`EchoRow`) drawn through the renderer its real row will use. It carries no
 * row identity (nothing may anchor or restore a reading position on a row that
 * is about to be replaced) and its actions are inert: they would act on a line
 * the transcript does not hold yet. Its action box is still drawn, so the text
 * wraps exactly as it will once the real row takes over. The rest of the row
 * stays live — a thought being written opens like any card.
 *
 * `beforeWindow`: a real event drawn ahead of the loaded window (the prompt of
 * the turn the window opens inside). It keeps its content identity but has no
 * position in the drawn events, so it carries no `data-event-index`.
 */
export function EventRow({
  event,
  hosted,
  ...at
}: {
  event: JsonlEvent;
  hosted?: readonly ContextMember[];
} & ({ index: number } | { beforeWindow: true } | { standIn: true })) {
  const dispatch = <JsonlViewer.EventRenderer.Dispatch event={event} />;
  const identity =
    "index" in at
      ? { "data-event-index": at.index, "data-event-key": eventKey(event) }
      : "beforeWindow" in at
        ? { "data-event-key": eventKey(event) }
        : {};
  return (
    <EventActionProvider event={event} inert={"standIn" in at}>
      <RowMarkdownProvider>
        <div className={rowActionsAnchor} {...identity}>
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
