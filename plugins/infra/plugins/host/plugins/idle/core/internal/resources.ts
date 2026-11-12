import { z } from "zod";
import { nullable, type FieldsRecord } from "@plugins/fields/core";
import { enumTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { externalIdField } from "@plugins/ids/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { HOST_IDLE_STATES } from "./next-state";

/** The most blockers a host can have: one per contributing plugin. */
export const MAX_IDLE_BLOCKERS = 32;

/** One blocker as the last evaluation saw it. */
export const IdleBlockerStatusSchema = z.object({
  id: z.string(),
  busy: z.boolean(),
  label: z.string(),
});
export type IdleBlockerStatus = z.infer<typeof IdleBlockerStatusSchema>;

const blockersSchema = cappedList(IdleBlockerStatusSchema, {
  max: MAX_IDLE_BLOCKERS,
});

/** The singleton row's fixed id. */
export const HOST_IDLE_STATE_ID = "host";

/** The host idle state, as the last evaluation wrote it (one row, main's DB). */
export const hostIdleStateFields = {
  id: externalIdField({
    reason: "a singleton table: its one row's fixed id (HOST_IDLE_STATE_ID)",
  }),
  state: enumTextField(HOST_IDLE_STATES),
  quietSince: nullable(dateField()),
  idleSince: nullable(dateField()),
  evaluatedAt: dateField(),
  /** When the evaluation runs again with no event to wake it; null: only an event. */
  wakeAt: nullable(dateField()),
  blockers: jsonField({ schema: blockersSchema, default: [] }),
} satisfies FieldsRecord;
export const hostIdleStateEntityRef = entityRef(
  "host_idle_state",
  hostIdleStateFields,
);

/**
 * Whether the host is idle: every contributed blocker quiet, for
 * `IDLE_SUSTAIN_MS`. `unevaluated` before main's first evaluation landed.
 * Instants are ISO strings.
 *
 * Evaluated by main's backend only (the blockers watch host-wide state, and
 * one evaluator owns the transitions): any other backend refuses it
 * `main-only`, which a reader renders as such — it never stands in a state.
 */
export const HostIdleSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unevaluated") }),
  z.object({
    state: z.enum(HOST_IDLE_STATES),
    quietSince: z.string().nullable(),
    idleSince: z.string().nullable(),
    evaluatedAt: z.string(),
    blockers: blockersSchema,
  }),
]);
export type HostIdle = z.infer<typeof HostIdleSchema>;

export const hostIdle = liveValue("host.idle", {
  schema: HostIdleSchema,
  refusals: ["main-only"],
});
