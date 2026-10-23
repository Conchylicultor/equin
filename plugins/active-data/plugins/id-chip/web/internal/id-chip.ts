import type { ComponentType } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { Hint } from "@plugins/hints/core";
import { Hints } from "@plugins/hints/web";
import { IdKinds, type IdPresenter } from "@plugins/ids/web";
import {
  InlineChip,
  inlineChip,
} from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/web";
import { idChipPattern, type IdChipSurface } from "../../core";
import { genericIdChip } from "../components/generic-id-chip";

type ChipComponent = ComponentType<{
  content: string;
  attrs: Record<string, string>;
}>;

/**
 * A kind's id chip, web half: the kind's `IdKinds.Presenter` AND its inline
 * chip, minted together so neither can exist without the other.
 *
 * ```ts
 * contributions: [
 *   ...idChip({ presenter: { kind: taskIdKind, useReferent, useTarget }, surfaces: ["transcript", "document"] }),
 * ]
 * ```
 *
 * Why a factory the family calls, rather than id-chip reading the presenter
 * slot and declaring the chips itself: a web slot is readable only through a
 * React hook, while `inlineChip()` must run at MODULE EVAL — the Lexical hosts
 * and the runs↔doc projection read the chip registry outside any render, and
 * every chip must also stand in the `InlineChip.Tag` declaration surface the
 * docs and the active-data checks read. A chip generated from a slot read
 * would be registered too late for the former and invisible to the latter.
 * So the family's barrel calls this once, and both halves derive from the
 * kind: the pattern is `idChipPattern(kind)` (never re-typed), the chip id is
 * the kind's prefix, and the model reads a resolved id (`modelText:
 * "resolved"`), whose server half is `idChipServer`.
 *
 * `component` overrides the generic chip (title + icon, opening via
 * `useTarget`) for a family with richer chrome (a status dot, a count).
 *
 * `hint` is a first-meeting tip on the generic chip (its anchor is the
 * chip's own): declared to the hints engine here, and requested by every
 * resolved chip of the kind — so it shows the first time one appears.
 */
export function idChip(spec: {
  presenter: IdPresenter;
  surfaces: readonly IdChipSurface[];
  component?: ChipComponent;
  hint?: Hint;
}): Contribution[] {
  const { presenter, surfaces, hint } = spec;
  return [
    ...(hint ? [Hints.Hint({ hint })] : []),
    IdKinds.Presenter(presenter),
    InlineChip.Tag(
      inlineChip({
        id: presenter.kind.prefix,
        pattern: idChipPattern(presenter.kind),
        surfaces,
        modelText: "resolved",
        component: spec.component ?? genericIdChip(presenter, hint),
      }),
    ),
  ];
}
