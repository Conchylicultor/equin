import type { ComponentType } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import {
  defineMountSlot,
  defineRenderSlot,
} from "@plugins/primitives/plugins/slot-render/web";

/**
 * One part of the header's status line, as its owner reads it:
 *
 * - `pending` — its data is not known yet (the line shows it loading, never a
 *   zero it would take back);
 * - `failed` — its read failed; the line says it could not read `subject`;
 * - `ready` — `text` (or `null`: nothing worth saying right now) and whether
 *   it needs the user (`attention` lights the menu-bar icon's dot).
 */
export type MenuBarStatus =
  | { kind: "pending" }
  | { kind: "failed"; subject: string }
  | { kind: "ready"; text: string | null; attention: boolean };

export const MenuBar = {
  /** A block of the panel, top to bottom in the slot's reorder config
   * (`config/menu-bar/menu-bar.Section.jsonc`). The panel names none: header,
   * task field, app grid, notifications switch and footer are all sections. A
   * section that has nothing to offer on this host renders `null`. */
  Section: defineRenderSlot<{ label: string; component: ComponentType }>({
    docLabel: (p) => p.label,
  }),
  /** A part of the header's one-line status ("2 agents working · 1 needs
   * you"), joined with " · " in the slot's order. Any part's `attention`
   * sets the dot on the menu-bar icon. */
  Status: defineRenderSlot<{
    label: string;
    useStatus: Hook<() => MenuBarStatus>;
  }>({ docLabel: (p) => p.label }),
  /** Headless work that runs while the panel page is alive — the helper keeps
   * the panel's webview loaded while hidden, so a mount here keeps running
   * (e.g. forwarding new notifications to the OS). */
  Mount: defineMountSlot({ docLabel: (p) => p.id }),
};
