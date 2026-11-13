import type { ComponentType } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { Hint } from "@plugins/hints/core";
import { Hints } from "@plugins/hints/web";
import { IdKinds, type IdPresenter } from "@plugins/ids/web";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { PaneTarget } from "@plugins/primitives/plugins/pane/web";
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

/** What a chip may write after its id — see `idChip`'s `qualifier`. */
export interface IdChipQualifier {
  /** The qualifier's grammar, unanchored and without flags. */
  pattern: RegExp;
  /** The pane a chip written with qualifier `written` opens. */
  usePane: Hook<(id: string, written: string) => PaneTarget>;
  /** What the chip adds to the referent's title for `written` ("Floating · Dense"). */
  label: (written: string) => string;
}

/**
 * A kind's id chip, web half: the kind's `IdKinds.Presenter` AND its inline
 * chip, minted together so neither can exist without the other.
 *
 * ```ts
 * contributions: [
 *   ...idChip({ presenter: { kind: taskIdKind, useReferent, usePane }, surfaces: ["transcript", "document"] }),
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
 * `component` overrides the generic chip (title + icon, opening
 * `usePane`'s pane) for a family with richer chrome (a status dot, a count).
 *
 * `qualifier` lets a chip name a VIEW of its referent after the id
 * (`proto-…?pane=floating` — one variant of a prototype): the chip's pattern
 * takes it optionally (`idChipPattern(kind, qualifier.pattern)` — the server
 * half must be handed the same pattern), and a chip written with one opens
 * `qualifier.usePane(id, written)` and adds `qualifier.label(written)` to its
 * title. A chip written without one is the plain id chip.
 *
 * `hint` is a first-meeting tip on the generic chip (its anchor is the
 * chip's own): declared to the hints engine here, and requested by every
 * resolved chip of the kind — so it shows the first time one appears.
 */
export function idChip(spec: {
  presenter: IdPresenter;
  surfaces: readonly IdChipSurface[];
  component?: ChipComponent;
  qualifier?: IdChipQualifier;
  hint?: Hint;
}): Contribution[] {
  const { presenter, surfaces, hint, qualifier } = spec;
  if (spec.component !== undefined && qualifier !== undefined) {
    throw new Error(
      `idChip(${presenter.kind.prefix}): a qualifier is read by the generic chip — a family bringing its own component reads the token itself.`,
    );
  }
  return [
    ...(hint ? [Hints.Hint({ hint })] : []),
    IdKinds.Presenter(presenter),
    InlineChip.Tag(
      inlineChip({
        id: presenter.kind.prefix,
        pattern: idChipPattern(presenter.kind, qualifier?.pattern),
        surfaces,
        modelText: "resolved",
        component: spec.component ?? genericIdChip(presenter, hint, qualifier),
      }),
    ),
  ];
}
