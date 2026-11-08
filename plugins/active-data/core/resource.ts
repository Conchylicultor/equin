import { z } from "zod";
import type { FieldsRecord } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { compositeKey } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { liveCollection } from "@plugins/network/plugins/live/core";

/**
 * One widget's persisted state, keyed by the widget's stable position in its
 * conversation: `(conversationId, messageId, tag, occurrenceIndex)`.
 *
 * `payload` has one shape per widget `tag`, owned by that tag's own consumer —
 * which safe-parses its own schema at the point of use. So the field declares
 * `unknown` and means it: a decoder here would have nothing to verify.
 */
export const activeDataBindingFields = {
  conversationId: textField(),
  messageId: textField(),
  tag: textField(),
  occurrenceIndex: intField(),
  payload: jsonField<unknown>({ schema: z.unknown() }),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

/** The `active_data_bindings` entity — one field record for the table and the wire. */
export const activeDataBindingsEntityRef = entityRef(
  "active_data_bindings",
  activeDataBindingFields,
);

/**
 * A binding's id: the table's composite primary key. A widget reads its own
 * row by it (`useLive(activeDataBindings, { id })`).
 */
export const activeDataBindingKey = compositeKey([
  "conversationId",
  "messageId",
  "tag",
  "occurrenceIndex",
]);

// One conversation's widget bindings: a scoped whole set
// (`all: { by: ["conversationId"] }`), one tuple per conversation, keyed by the
// table's composite primary key — so a binding written in another conversation
// reaches no tuple (the router skips it on the carried `conversation_id`), and
// one written in this conversation is a one-row refill shipped as a keyed
// delta. A widget reads its own row by id (`activeDataBindingKey`); the
// conversation's scope is the tuple a whole-conversation reader holds.
//
// Bounded by construction: a tuple is one conversation's handful of widgets.
//
// The key is NEW (`active-data.bindings.v2`; it was the param'd value
// `active-data.bindings`): a tab still on a bundle that subscribed the old key
// gets `unknown-key` — a `skew` verdict, the Reload prompt — instead of parsing
// keyed deltas its value read cannot apply (C39). Pinned by
// `../web/__tests__/active-data-bindings-old-tab.test.ts`.
export const activeDataBindings = liveCollection("active-data.bindings.v2", {
  from: activeDataBindingsEntityRef,
  carry: {
    pick: ["conversationId", "messageId", "tag", "occurrenceIndex", "payload"],
  },
  id: activeDataBindingKey,
  all: {
    by: ["conversationId"],
    orderBy: [
      ["messageId", "asc"],
      ["tag", "asc"],
      ["occurrenceIndex", "asc"],
    ],
    unbounded: {
      reason:
        "one conversation's widget bindings — a handful per assistant message",
      // Measured on main, 2026-11-08: 4 for the largest conversation.
      budget: 50,
    },
  },
});

/** A row as `activeDataBindings` delivers it. */
export const ActiveDataBindingSchema = activeDataBindings.row;
export type ActiveDataBinding = z.infer<typeof ActiveDataBindingSchema>;
