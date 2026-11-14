import { z } from "zod";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { idKindField } from "@plugins/ids/core";
import { eventMessageIdKind, pendingEventIdKind } from "./id-kinds";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/** The most report kinds a route's filter names (a stream has a few dozen). */
export const ROUTE_KINDS_MAX = 200;

/**
 * Where one stream's events go: at most one supervisor role per stream (the
 * stream id is the key). `kinds` narrows it to some of the stream's kinds;
 * null is every kind.
 */
export const eventRouteFields = {
  streamId: textField({ label: "Stream" }),
  roleId: textField({ label: "Supervisor" }),
  kinds: nullable(
    jsonField({ schema: cappedList(z.string(), { max: ROUTE_KINDS_MAX }) }),
  ),
} satisfies FieldsRecord;
export const eventRoutesEntityRef = entityRef(
  "supervisor_event_routes",
  eventRouteFields,
);
export const EventRouteSchema = fieldsToZodObject(eventRouteFields);
export type EventRoute = z.infer<typeof EventRouteSchema>;

/** What happens to a message when the role has no live session. */
export const IDLE_POLICIES = ["drop", "backlog", "launch"] as const;
export type IdlePolicy = (typeof IDLE_POLICIES)[number];

/** The quiet period after a message when none is configured. */
export const DEFAULT_GAP_MINUTES = 10;
export const DEFAULT_IDLE_POLICY: IdlePolicy = "drop";
export const GAP_MINUTES_MAX = 24 * 60;

/**
 * A role's event settings. A role with no row has the defaults
 * ({@link DEFAULT_GAP_MINUTES}, {@link DEFAULT_IDLE_POLICY}).
 *
 * - `gapMinutes` — after a message, the quiet period that gathers what
 *   follows into the next one.
 * - `idle` — a message with no live session: dropped, filed as one backlog
 *   task, or the session it launches is briefed with it.
 */
export const eventSettingsFields = {
  roleId: textField({ label: "Supervisor" }),
  gapMinutes: intField({
    label: "Space messages",
    min: 1,
    max: GAP_MINUTES_MAX,
    default: DEFAULT_GAP_MINUTES,
  }),
  idle: enumTextField(IDLE_POLICIES, {
    label: "No live session",
    options: {
      drop: { label: "Drop" },
      backlog: { label: "File in backlog" },
      launch: { label: "Launch a session" },
    },
  }),
} satisfies FieldsRecord;
export const eventSettingsEntityRef = entityRef(
  "supervisor_event_settings",
  eventSettingsFields,
);
export const EventSettingsSchema = fieldsToZodObject(eventSettingsFields);
export type EventSettings = z.infer<typeof EventSettingsSchema>;

/**
 * The most distinct events one role gathers for its next message. Past it,
 * further distinct events fold into one "other" line — a message is a
 * summary, and a storm of distinct fingerprints must not grow it unbounded.
 */
export const PENDING_PER_ROLE_MAX = 100;

/**
 * One event gathered for a role's next message, folded by its key (a
 * report's fingerprint): `count` occurrences since `firstAt`.
 */
export const eventPendingFields = {
  id: idKindField(pendingEventIdKind),
  roleId: textField({ label: "Supervisor" }),
  streamId: textField({ label: "Stream" }),
  key: textField(),
  kind: textField({ label: "Kind" }),
  title: textField({ label: "Event" }),
  ref: nullable(textField()),
  count: intField({ label: "Events", min: 1, default: 1 }),
  firstAt: dateField({ label: "First" }),
  lastAt: dateField({ label: "Last" }),
} satisfies FieldsRecord;
export const eventPendingEntityRef = entityRef(
  "supervisor_event_pending",
  eventPendingFields,
);

/** One summarized line of a message: `×count kind · title`. */
export const EventLineSchema = z.object({
  streamId: z.string(),
  kind: z.string(),
  title: z.string(),
  ref: z.string().nullable(),
  count: z.number().int().min(1),
});
export type EventLine = z.infer<typeof EventLineSchema>;

/**
 * What became of a message. `sending` is a message claimed from the gathered
 * events and being delivered (outside the claiming transaction): it holds the
 * role's quiet period, and turns into its outcome — or, if delivery throws, is
 * deleted and its events go back to the gathered ones.
 */
export const MESSAGE_OUTCOMES = [
  "sending",
  "sent",
  "dropped",
  "filed",
  "launched",
] as const;
export type MessageOutcome = (typeof MESSAGE_OUTCOMES)[number];

/**
 * The most event lines a message's text shows; the rest are summed in one
 * `+N more` line (their events by kind), and read whole with the
 * `read_event_message` tool (every line is kept on the message row).
 */
export const MESSAGE_LINES_SHOWN = 20;

/** Messages kept per role (older ones are pruned as new ones land). */
export const MESSAGES_KEPT_PER_ROLE = 50;

/**
 * One message a role's events made: its lines (one per distinct event,
 * already summarized), how many events they fold, and what became of it —
 * typed into the live session, dropped, filed as a backlog task, or briefed
 * into a session it launched.
 */
export const eventMessageFields = {
  id: idKindField(eventMessageIdKind),
  roleId: textField({ label: "Supervisor" }),
  sentAt: dateField({ label: "Sent" }),
  events: intField({ label: "Events", min: 1, default: 1 }),
  lines: jsonField({
    schema: cappedList(EventLineSchema, { max: PENDING_PER_ROLE_MAX + 1 }),
  }),
  outcome: enumTextField(MESSAGE_OUTCOMES, {
    label: "Outcome",
    options: {
      sending: { label: "Sending" },
      sent: { label: "Sent" },
      dropped: { label: "Dropped" },
      filed: { label: "Filed in backlog" },
      launched: { label: "Launched a session" },
    },
  }),
  taskId: nullable(textField()),
} satisfies FieldsRecord;
export const eventMessagesEntityRef = entityRef(
  "supervisor_event_messages",
  eventMessageFields,
);
