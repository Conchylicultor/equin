import { useMemo, type ReactNode } from "react";
import type { PendingTurn } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { echoEventOf } from "../echo-event";
import { EventRow } from "./event-row";
import { StickyUserHeader } from "./sticky-user-header";

/**
 * A sent turn the transcript does not hold yet, drawn as the transcript WILL
 * draw it: a stand-in of the row its line becomes (`echoEventOf`) through the
 * same renderer — a prompt in the same pinned section header, opening a
 * section of its own; an `event` turn as the inline event card the transcript
 * never pins — so when the real row replaces it, the row does not move,
 * re-wrap or change colour. `status` (the in-flight line) sits under it, inset
 * like the transcript's text rows, and is the only thing that goes away.
 *
 * The stand-in's `uuid` is the turn id: a typed prompt's row carries one, and
 * the row actions it enables (rewind, fork) are part of the box the text wraps
 * around. The row is inert, so nothing ever acts on it.
 */
export function EchoRow({
  turn,
  status,
}: {
  turn: Pick<PendingTurn, "id" | "kind" | "text" | "sentAt">;
  status: ReactNode;
}) {
  const { id, kind, text, sentAt } = turn;
  const event = useMemo(
    () => echoEventOf({ id, kind, text, sentAt }),
    [id, kind, text, sentAt],
  );
  const row = <EventRow event={event} standIn />;
  return (
    <Stack gap="sm">
      {event.kind === "user-text" ? (
        <StickyUserHeader>{row}</StickyUserHeader>
      ) : (
        row
      )}
      <div className="px-md">{status}</div>
    </Stack>
  );
}
