import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { useConversationNote } from "../internal/use-conversation-note";
import { symbol } from "@plugins/ui/plugins/icons/core";

const stickyNote2Icon = symbol("sticky-note-2");

/**
 * The note's toggle: opens and hides an empty note. A written note always
 * shows, and marks the button with a dot on the icon's corner.
 */
export function NotesToggleButton({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  const { isVisible, noteExists, read, toggleVisible } = useConversationNote(
    conversation.id,
  );

  // Nothing to offer until the note is known: "Add note" over a note that
  // exists would be a lie. A failed read keeps the button's face and says so —
  // it is the one place the failure is reported (the area stays hidden).
  if (read.status === "loading") return null;
  if (read.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        icon={stickyNote2Icon}
        subject="the note"
        error={read.error}
        refetch={read.refetch}
      />
    );

  return (
    // The positioning context the written-note dot pins to.
    <Stack as="span" direction="row" gap="none" className="relative">
      <IconButton
        icon={stickyNote2Icon}
        glyph="small"
        className={cn(!isVisible && "text-muted-foreground")}
        label={
          noteExists
            ? "Clear the note to hide it"
            : isVisible
              ? "Hide note"
              : "Add note"
        }
        active={isVisible}
        aria-pressed={isVisible}
        onClick={toggleVisible}
      />
      {noteExists && (
        <Pin to="top-right" offset="xs" decorative>
          <StatusDot colorClass="bg-warning" />
        </Pin>
      )}
    </Stack>
  );
}
