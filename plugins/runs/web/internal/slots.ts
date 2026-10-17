import { defineDispatchSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { RunRow } from "../../core";
import { GenericRunLeading } from "../components/generic-run-leading";

/** The props every per-kind row affordance receives: the merged row itself. */
export interface RunRowProps {
  run: RunRow;
}

/**
 * The seam an arm reaches the merged surface through beside its fields
 * (`liveArm`), its row links (`runLinks` — data-view's
 * `CollectionRowActivation`) and its Investigate action (`investigateRuns`).
 *
 * **The row body is not one of them, deliberately.** There used to be a
 * `Runs.Row` an arm could replace the whole line with, and it cost the surface
 * its schema: the list installs a `renderRow` override the moment ANY arm
 * contributes one, and that override replaces the field-driven body for EVERY
 * kind — so one arm's bespoke row silently switched off the Properties panel for
 * all four. What an arm wanted it for was never really a row, either: it was a
 * detail surface it did not have yet (backup's expand/collapse card) or a set of
 * chips its own fields already described (deploy's).
 *
 * So a row is fields, and only fields. A domain's detail belongs in the pane its
 * `runLinks` pushes; a domain's columns are its arm's fields (`liveArm`, core;
 * presented by `FieldPresentation.Register({ owner: arm })`), where they are
 * also filterable, sortable and groupable rather than merely visible. Its kind
 * and label are the arm's too (`liveArm({ label, order })`): every list
 * derives the `kind` source field's options from the registered arms.
 */
export const Runs = {
  /**
   * The list-row leading indicator for one kind. Falls back to the outcome dot.
   *
   * The one presentational seam that survives, because it is a fixed-size glyph
   * in a slot the list already owns — it cannot grow to swallow the row.
   */
  Leading: defineDispatchSlot<RunRowProps, string>({
    key: (p) => p.run.kind,
    fallback: GenericRunLeading,
  }),
};
