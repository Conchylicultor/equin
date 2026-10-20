import { useCallback, useMemo } from "react";
import { OutlineRail } from "@plugins/primitives/plugins/outline/plugins/rail/web";
import { scrollToBottom } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  paneScrollScope,
  useTranscriptEvents,
  useVisibleEvents,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { eventKey } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const keyboardArrowDownIcon = symbol("keyboard-arrow-down");

const MAX_PREVIEW = 50;

/**
 * Entries are keyed by content identity, never by position.
 *
 * The id used to be the index into the *unfiltered* resource array while the DOM
 * stamps `data-event-index` over the *filtered* one, so every entry pointed at
 * the wrong row in any conversation where a `JsonlViewer.EventFilter` had hidden
 * something earlier — `ask-user-question` hides `user-text` events, which is
 * exactly the kind listed here. `eventKey(ev)` is stamped on the row itself
 * (`data-event-key`), so an entry and its row cannot drift apart.
 */
function userTurnEntries(events: JsonlEvent[]) {
  const entries: { id: string; label: string; depth: number }[] = [];
  for (const ev of events) {
    if (ev.kind !== "user-text") continue;
    const firstLine = ev.text.split("\n", 1)[0] ?? "";
    entries.push({
      id: eventKey(ev),
      label:
        firstLine.length <= MAX_PREVIEW
          ? firstLine
          : firstLine.slice(0, MAX_PREVIEW) + "…",
      // Flat: one entry per user turn. Depth exists for outlines that nest
      // (a page's headings); a transcript has no sub-levels to express.
      depth: 0,
    });
  }
  return entries;
}

export function ConversationOutline() {
  // The transcript the enclosing view draws, so a sub-agent's pane outlines the
  // sub-agent rather than the parent conversation it hangs off.
  const events = useTranscriptEvents();
  // The rendered set, not the raw resource: listing an event the transcript
  // filters out offers an entry with no row behind it.
  const visible = useVisibleEvents(events);
  const entries = useMemo(() => userTurnEntries(visible), [visible]);

  // THIS pane's transcript, never `document`: two panes can be open on the same
  // conversation, and a row's key (`user-text:<timestamp>`) carries no
  // conversation id — so the other pane's rows answer to the identical selector,
  // and a global lookup would scroll the wrong transcript.
  const scroller = paneScrollScope.useRoot();

  const resolve = useCallback(
    // Before the transcript attaches there is no row for ANY id — one commit,
    // and the rail re-enrols when the elements appear. Distinct from a row that
    // is genuinely absent, which is what the null below means.
    (id: string) =>
      scroller.attached
        ? scroller.root.querySelector(`[data-event-key="${CSS.escape(id)}"]`)
        : null,
    [scroller],
  );

  return (
    <OutlineRail
      entries={entries}
      resolve={resolve}
      label="Conversation outline"
      footer={
        // Takes the footer row's whole width — the rail centers a narrower
        // footer, but this one is the only thing down there, so the target
        // should be the strip itself and not a chevron-sized box inside it.
        // Height still comes from the ambient control density; only the square
        // aspect's width is given up. `Button` centers its own glyph.
        <IconButton
          icon={keyboardArrowDownIcon}
          label="Scroll to bottom"
          className="w-full"
          onClick={() =>
            scrollToBottom(scroller.attached ? scroller.root : null, {
              behavior: "smooth",
            })
          }
        />
      }
    />
  );
}
