import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { defineDispatchSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { OpenPaneFn } from "@plugins/primitives/plugins/pane/web";
import type { FieldsRecord } from "@plugins/fields/core";
import type { LiveArm } from "@plugins/network/plugins/live/core";
import type { RunRow } from "../../core";
import { GenericRunLeading } from "../components/generic-run-leading";

/** The props every per-kind row affordance receives: the merged row itself. */
export interface RunRowProps {
  run: RunRow;
}

/** One arm of the `runs` union, as its core declares it (`liveArm(runs, kind, …)`). */
export type RunArm = LiveArm<RunRow, FieldsRecord, string>;

/**
 * What an arm registers on the web: the arm itself — its kind and label are
 * the arm's (`liveArm(runs, kind, { label })`), never restated — and,
 * optionally, where a row of that kind goes when it is clicked.
 *
 * The kinds cannot come from the server registry: the `kind` filter chip has
 * to offer every kind, including the ones with no row on the current page, so
 * its options are derived from the registered kinds rather than from the
 * loaded window. This is that registration.
 *
 * `link` receives the caller's own `openPane`, so the arm navigates from the
 * surface the row is rendered in rather than always at the root. It returns a
 * {@link LinkTarget} (`openPane.to(...)`), not a bare open, so a row is a link:
 * middle- and ⌘-click open the run's pane in a new browser tab. An arm with no
 * detail surface omits it, and its rows simply do not activate — which is the
 * honest behaviour, not a click that quietly does nothing.
 */
export interface RunKindContribution {
  arm: RunArm;
  link?: (run: RunRow, ctx: { openPane: OpenPaneFn }) => LinkTarget;
}

/**
 * The seams an arm reaches the merged surface through.
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
 * `Kind.link` pushes; a domain's columns are its arm's fields (`liveArm`, core;
 * presented by `FieldPresentation.Register({ owner: arm })`), where they are
 * also filterable, sortable and groupable rather than merely visible.
 */
export const Runs = {
  /** One per arm: the kind's label, and optionally how to open one of its rows. */
  Kind: defineSlot<RunKindContribution>({
    docLabel: (c) => c.arm.owner.arm,
  }),
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
