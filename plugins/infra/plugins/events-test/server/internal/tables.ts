import { text } from "drizzle-orm/pg-core";
import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";
import { PINGED_EVENT_NAME } from "../../shared/pinged";

export interface PingedPayload {
  userId: string;
  message: string;
  [key: string]: unknown;
}

// Simple unconstrained `userId` column (no FK) so this dummy plugin stays
// self-contained. Identity-or-null match on payload.userId.
export const { event: pinged, table: _pingedTriggers } =
  defineTriggerEvent<PingedPayload>({
    name: PINGED_EVENT_NAME,
    filters: {
      userId: text("user_id"),
    },
  });
