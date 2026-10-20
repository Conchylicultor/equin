import { useCallback, useEffect, useMemo, useState } from "react";
import { OutlineRail } from "@plugins/primitives/plugins/outline/plugins/rail/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { scrollToBottom } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import {
  paneScrollScope,
  useTranscriptDrawn,
  useVisibleEvents,
  useWholeTranscript,
  type TranscriptOlder,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { eventKey } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { conversationTurns, userTurnsOf, type OutlineTurn } from "../../core";

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
function useEntries(turns: readonly OutlineTurn[]) {
  // The rendered set, not every turn: listing an event the transcript filters
  // out offers an entry with no row behind it.
  const events = useMemo(() => turns.map((t) => t.event), [turns]);
  const visible = useVisibleEvents(events);
  return useMemo(() => {
    const entries: { id: string; label: string; depth: number }[] = [];
    for (const ev of visible) {
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
  }, [visible]);
}

export function ConversationOutline() {
  // Every turn of the transcript the view draws — the conversation's, read
  // from the server while the pane holds only its latest events; a sub-agent
  // pane's own otherwise.
  const { older, seekOlder } = useTranscriptDrawn();
  const turns = useWholeTranscript(conversationTurns, userTurnsOf);
  // The outline is chrome beside the transcript: nothing until its turns land.
  return matchResource(turns, {
    loading: () => null,
    error: () => null,
    ready: (data) => (
      <OutlineBody turns={data} older={older} seekOlder={seekOlder} />
    ),
  });
}

function OutlineBody({
  turns,
  older,
  seekOlder,
}: {
  turns: readonly OutlineTurn[];
  older: TranscriptOlder | null;
  seekOlder: ((seeking: boolean) => void) | null;
}) {
  const entries = useEntries(turns);

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

  // A turn older than the loaded window: the view seeks into the older part
  // (it sits at the top and keeps loading pages), and the turn's row is
  // revealed once it has mounted and nothing is landing above it any more.
  const { events } = useTranscriptDrawn();
  const [pending, setPending] = useState<string | null>(null);
  const jumpToUnmounted = useCallback(
    (id: string) => {
      setPending(id);
      seekOlder?.(true);
    },
    [seekOlder],
  );
  useEffect(() => {
    if (pending === null) return;
    if (older?.growing) return;
    const row = resolve(pending);
    if (row) {
      seekOlder?.(false);
      revealElement(row, { behavior: "auto", block: "start" });
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the jump is done once its row has mounted; clearing it completes the effect's own work
      setPending(null);
    } else if (older !== null && !older.canGrow) {
      // Everything is loaded and the row is not there (filtered out): nothing
      // to jump to.
      seekOlder?.(false);
      setPending(null);
    }
  }, [pending, events, resolve, older, seekOlder]);

  return (
    <OutlineRail
      entries={entries}
      resolve={resolve}
      onUnmounted={seekOlder ? jumpToUnmounted : undefined}
      // A window loads older pages as its top nears, which would move the
      // target under a smooth scroll already under way.
      revealBehavior={older ? "auto" : "smooth"}
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
