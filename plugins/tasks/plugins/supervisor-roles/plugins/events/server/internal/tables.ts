import { index, uniqueIndex } from "drizzle-orm/pg-core";
import {
  defaultNow,
  defineEntity,
} from "@plugins/infra/plugins/entities/server";
import { _supervisorRoles } from "@plugins/tasks/plugins/supervisor-roles/server";
import {
  DEFAULT_GAP_MINUTES,
  DEFAULT_IDLE_POLICY,
  eventMessagesEntityRef,
  eventPendingEntityRef,
  eventRoutesEntityRef,
  eventSettingsEntityRef,
} from "../../core";

// Physical tables, derived from the field records in `core/`. A load-order
// leaf (drizzle-kit's sync loader evaluates it). Every row belongs to a role
// and goes with it (ON DELETE CASCADE): a deleted role's streams go to nobody.

const roleRef = {
  references: {
    column: () => _supervisorRoles.id,
    onDelete: "cascade",
    onUpdate: "cascade",
  },
} as const;

/** One row per routed stream: the stream id is the key, so one role per stream. */
export const eventRoutesEntity = defineEntity(eventRoutesEntityRef, {
  primaryKey: "streamId",
  columns: { roleId: roleRef },
  indexes: (t) => [index("supervisor_event_routes_role_idx").on(t.roleId)],
});
export const _supervisorEventRoutes = eventRoutesEntity.table;

export const eventSettingsEntity = defineEntity(eventSettingsEntityRef, {
  primaryKey: "roleId",
  columns: {
    roleId: roleRef,
    gapMinutes: { default: DEFAULT_GAP_MINUTES },
    idle: { default: DEFAULT_IDLE_POLICY },
  },
});
export const _supervisorEventSettings = eventSettingsEntity.table;

/** Gathered events, one row per (role, stream, key). */
export const eventPendingEntity = defineEntity(eventPendingEntityRef, {
  primaryKey: "id",
  columns: {
    roleId: roleRef,
    count: { default: 1 },
    firstAt: { default: defaultNow() },
    lastAt: { default: defaultNow() },
  },
  indexes: (t) => [
    uniqueIndex("supervisor_event_pending_key_idx").on(
      t.roleId,
      t.streamId,
      t.key,
    ),
  ],
});
export const _supervisorEventPending = eventPendingEntity.table;

export const eventMessagesEntity = defineEntity(eventMessagesEntityRef, {
  primaryKey: "id",
  columns: {
    roleId: roleRef,
    sentAt: { default: defaultNow() },
  },
  indexes: (t) => [
    index("supervisor_event_messages_role_idx").on(t.roleId, t.sentAt),
  ],
});
export const _supervisorEventMessages = eventMessagesEntity.table;
