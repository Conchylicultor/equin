import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";

/**
 * The BASE fields of the activity space — the ones every kind of record
 * projects, so a filter, a sort or a group-by means the same thing on every
 * row — in list order. A kind's own fields (a conversation's status, a task's
 * track, a page's tags) ride its rows under `$columns`, declared by its arm
 * (`liveArm(activity, kind, { from, pick })`) or EXPOSED by an extension of
 * its entity — the arm is declared from the entity, so every exposed field
 * of it joins the arm's band with no code here.
 */
const activityFields = {
  /** The record's name. NULL for a conversation no one has titled yet. */
  title: nullable(textField({ label: "Title", primary: true })),
  /** Which kind of record the row is — the discriminator (its options: the registered arms). */
  type: textField({ label: "Type" }),
  /**
   * The record's own last change (its `updated_at`, trigger-maintained by
   * derived-updated-at). A task's does not move while an agent works on it —
   * its conversation's row does; a page's moves on a rename or a move, not on
   * a content edit (see the page arm).
   */
  updatedAt: dateField({ label: "Last activity" }),
  createdAt: dateField({ label: "Created" }),
};

/**
 * **activity** — the records people and agents work on, of every kind, as ONE
 * routed union window (a Meta-DataView: research/2026-10-17-global-fields-
 * declared-once-phase4-entity-meta-dataview.md). Each kind is an arm declared
 * from its entity and bound by its own plugin (`activityServed.arm`); a write
 * to one table refills only the rows it changed.
 *
 * Newest activity first by default; read as key-range pages.
 *
 * **Arm order** — what a person last touched, nearest first: tasks (10), the
 * conversations working them (20), pages (30).
 */
export const activity = liveCollection("activity", {
  fields: activityFields,
  carry: {
    fields: {
      /** The union row key `type:id` — unique across tables. */
      key: textField(),
      /** The record's id **within its own table**. */
      id: textField(),
    },
  },
  id: "key",
  arms: { discriminator: "type" },
  sortable: ["type", "title", "updatedAt", "createdAt"],
  default: { orderBy: [["updatedAt", "desc"]], limit: 50 },
  maxLimit: 200,
});

/** One row of the activity space, with its arm's own fields under `$columns`. */
export type ActivityRow =
  typeof activity extends LiveRowsCollection<infer R> ? R : never;
