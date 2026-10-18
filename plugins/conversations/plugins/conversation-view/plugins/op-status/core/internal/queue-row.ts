import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { rowKind } from "@plugins/network/plugins/live/core";

/**
 * How a row of the expanded list reads at a glance. `queued` is waiting its
 * turn in an ordinary line (the push mutex, the build lock, the host grant) —
 * the expected case, told by the glyph alone. `held` is a wait nobody queues
 * for (the duress valve) and says so in words.
 */
export const OP_ROW_PHASES = ["working", "held", "queued"] as const;
export type OpRowPhase = (typeof OP_ROW_PHASES)[number];

/**
 * One in-flight op as a row of the banner's expanded list: the op, plus the
 * values the list shows of it — its phase, its place in the push queue, the
 * conversation's title, what holds it and the three clocks. Ops are database
 * data, but these rows are assembled in the browser (the clocks tick, the
 * titles come from another read), so this is a row kind (a collection with no
 * server), declared once; the list says only how each field presents
 * (`overrides`) and the section it groups by (`extraFields` — its options are
 * the sections in flight, in their display order).
 */
export const opQueueRow = rowKind("op-status.queue-row", {
  fields: {
    phase: enumTextField(OP_ROW_PHASES, {
      label: "Phase",
      options: {
        working: { label: "Working" },
        held: { label: "Held" },
        queued: { label: "Queued" },
      },
    }),
    pos: nullable(intField({ label: "Queue position" })),
    title: textField({ label: "Conversation", primary: true }),
    held: nullable(textField({ label: "Held" })),
    waited: floatField({ label: "Waited" }),
    worked: floatField({ label: "Worked" }),
    asleep: floatField({ label: "Asleep" }),
  },
  // What the cells read beyond the listed fields: the worktree's slug, whether
  // the row is the open conversation's own, and the op's one state line.
  carry: {
    fields: {
      opId: textField(),
      slug: textField(),
      isSelf: boolField(),
      state: textField(),
    },
  },
  id: "opId",
});
