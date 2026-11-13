import type { ComponentType } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";

/**
 * One part of the header's status line, as its owner reads it:
 *
 * - `pending` — its data is not known yet (the line shows it loading, never a
 *   zero it would take back);
 * - `failed` — its read failed; the line says it could not read `subject`;
 * - `ready` — `text` (or `null`: nothing worth saying right now) and whether
 *   it needs the user (`attention`: the companion's own signal — the menu-bar
 *   icon's dot, a toolbar badge).
 */
export type CompanionStatus =
  | { kind: "pending" }
  | { kind: "failed"; subject: string }
  | { kind: "ready"; text: string | null; attention: boolean };

/**
 * What a companion's own section slot carries (`MenuBar.Section`, …): a block
 * of the panel, top to bottom in that slot's reorder config. Each companion
 * declares its own slot of this shape, so each orders its sections itself;
 * `CompanionPanel` renders whichever it is handed.
 */
export interface CompanionSectionProps {
  label: string;
  component: ComponentType;
}

export const Companion = {
  /** A part of the header's one-line status ("2 agents working · 1 needs
   * you"), joined with " · " in the slot's order — the same line in every
   * companion. Any part's `attention` reaches the companion's host
   * (`CompanionPanel`'s `onAttention`). */
  Status: defineRenderSlot<{
    label: string;
    useStatus: Hook<() => CompanionStatus>;
  }>({ docLabel: (p) => p.label }),
};
