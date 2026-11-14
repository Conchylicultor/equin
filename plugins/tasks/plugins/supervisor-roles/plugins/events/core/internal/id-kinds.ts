import { defineIdKind, type IdOf } from "@plugins/ids/core";

/** One message a supervisor role's events made (`supervisor_event_messages.id`). */
export const eventMessageIdKind = defineIdKind({
  prefix: "sevmsg",
  label: "Supervisor event message",
});
export type EventMessageId = IdOf<typeof eventMessageIdKind>;

/** One event a role is gathering for its next message (`supervisor_event_pending.id`). */
export const pendingEventIdKind = defineIdKind({
  prefix: "sevt",
  label: "Gathered supervisor event",
});
export type PendingEventId = IdOf<typeof pendingEventIdKind>;
