import { useMemo, type ReactNode } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { EventRow } from "./event-row";
import { StickyUserHeader } from "./sticky-user-header";

/**
 * A sent turn the transcript does not hold yet, drawn as the transcript WILL
 * draw it: a `user-text` stand-in event through the same renderer, in the same
 * pinned section header, opening a section of its own — so when the real row
 * replaces it, the message does not move, re-wrap or change colour. `status`
 * (the in-flight line) sits under it, inset like the transcript's text rows,
 * and is the only thing that goes away.
 *
 * The stand-in's `uuid` is the turn id: a typed prompt's row carries one, and
 * the row actions it enables (rewind, fork) are part of the box the text wraps
 * around. The row is inert, so nothing ever acts on it.
 */
export function EchoRow({
  turnId,
  text,
  sentAt,
  status,
}: {
  turnId: string;
  text: string;
  sentAt: Date;
  status: ReactNode;
}) {
  const event = useMemo<JsonlEvent>(
    () => ({
      kind: "user-text",
      at: sentAt.toISOString(),
      text,
      uuid: turnId,
    }),
    [turnId, text, sentAt],
  );
  return (
    <Stack gap="sm">
      <StickyUserHeader>
        <EventRow event={event} standIn />
      </StickyUserHeader>
      <div className="px-md">{status}</div>
    </Stack>
  );
}
