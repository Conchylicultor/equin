import { useCallback, useLayoutEffect, useState } from "react";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useEditableField } from "@plugins/primitives/plugins/editable-field/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useConversationNote } from "../internal/use-conversation-note";
import { setDraft, setOpen, useNoteUi } from "../internal/notes-ui-store";
import { upsertNote, deleteNote } from "../internal/api";

/**
 * The note's one editor. It owns the draft and publishes it, so the toggle's
 * dot follows the text as it is typed rather than the debounced save.
 */
export function NotesArea({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  const conversationId = conversation.id;
  const fetchEndpoint = useFetchEndpoint();
  const { read, serverNote } = useConversationNote(conversationId);
  const { open } = useNoteUi(conversationId);
  const [isFocused, setIsFocused] = useState(false);

  const handleSave = useCallback(
    async (next: string) => {
      if (next.trim() === "") {
        await deleteNote(fetchEndpoint, conversationId);
      } else {
        await upsertNote(fetchEndpoint, conversationId, next);
      }
    },
    [conversationId, fetchEndpoint],
  );

  const { value, onChange, onFocus, onBlur, isSaving } =
    useEditableField<string>({
      value: serverNote,
      onSave: handleSave,
      debounceMs: 1000,
    });

  // Before paint, so the toggle's dot never lags the text by a frame.
  useLayoutEffect(() => {
    setDraft(conversationId, value);
  }, [conversationId, value]);
  useLayoutEffect(
    () => () => setDraft(conversationId, undefined),
    [conversationId],
  );

  const hasText = value.trim().length > 0;

  // The editor mounts only over a known note: seeded from a not-yet-loaded ""
  // it would race the real value in. A failed read is reported by the toolbar
  // toggle (NotesToggleButton), not a second time here.
  if (read.status !== "ready") return null;
  const isVisible = hasText || open;
  // Emptied while being typed in, the note hides — but the editor stays
  // mounted and focused (visually hidden) until it blurs, so the next
  // keystroke or Ctrl+Z (the browser's own undo history) brings it back.
  if (!isVisible && !isFocused) return null;

  return (
    <div className={cn("relative", !isVisible && "sr-only")}>
      <textarea
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          // Deleting the last of the text closes the note.
          if (hasText && next.trim() === "") setOpen(conversationId, false);
          onChange(next);
        }}
        onFocus={() => {
          setIsFocused(true);
          onFocus();
        }}
        onBlur={() => {
          setIsFocused(false);
          onBlur();
        }}
        placeholder="Notes…"
        // Grows with the text (field-sizing) from ~2 to ~12 lines, then
        // scrolls — a long note is never hidden behind a 2-line scrollbox.
        className="field-sizing-content max-h-[12lh] min-h-[3lh] w-full resize-y rounded-md border border-warning/60 bg-warning/10 px-md py-sm text-caption placeholder:text-warning/70 focus:outline-none focus:ring-1 focus:ring-warning"
        aria-label="Conversation notes"
      />
      {isSaving && isVisible && (
        <Pin
          as="span"
          to="bottom-right"
          decorative
          // off-ramp insets: right-2 / bottom-1.5 aren't a single ramp step
          style={{ right: "0.5rem", bottom: "0.375rem" }}
          className="text-3xs text-muted-foreground select-none"
        >
          Saving…
        </Pin>
      )}
    </div>
  );
}
