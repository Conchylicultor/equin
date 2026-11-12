import { defineEntity } from "@plugins/infra/plugins/entities/server";
import { hostIdleStateEntityRef } from "../../core";

// The host idle state: one row, written only by the evaluate job (main's
// backend). Plain state, not a ledger — a transition is an event.
const hostIdleState = defineEntity(hostIdleStateEntityRef, {
  primaryKey: "id",
});
export const _hostIdleState = hostIdleState.table;
