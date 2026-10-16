import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type React from "react";

import type { ControlPanelSize } from "./size";

// The stack's contract — entry, state, the context and its reader — apart from
// the stack COMPONENT, because a row reads it too (`ControlPanel.Row push`) and
// the stack component renders a row (its back header): one file each way would
// be an import cycle.

export interface PanelStackEntry {
  /** Identity of this level — a re-push with the same key replaces it. */
  key: string;
  /** Shown in the back header, so the user knows what popping returns to. */
  title: string;
  render: () => React.ReactNode;
  /**
   * The width role this page needs. REQUIRED, because the surface takes the
   * showing page's role (`ControlPanelPopover`) and the page is the only thing
   * that knows it: a filter builder pushed from a 248px menu needs the 524px
   * builder, and an omitted role once drew the fold editor's builder rows inside
   * a menu-wide panel. `"inherit"` keeps the role of the page it is pushed FROM
   * (the nearest entry below that names one, else the panel's own) — a drill-down
   * inside a builder stays builder-wide. A host with no width of its own to
   * change (a pane) ignores it.
   */
  size: ControlPanelSize | "inherit";
}

/**
 * The stack's state, for the one host that has to read it from OUTSIDE the
 * stack: `ControlPanelPopover`, whose surface width follows the showing page.
 */
export interface PanelStackState {
  entries: readonly PanelStackEntry[];
  push: (entry: PanelStackEntry) => void;
  pop: () => void;
  close: (key: string) => void;
  reset: () => void;
}

export function usePanelStackState(): PanelStackState {
  const [entries, setEntries] = useState<readonly PanelStackEntry[]>([]);
  const push = useCallback((entry: PanelStackEntry) => {
    setEntries((prev) =>
      prev.at(-1)?.key === entry.key ? prev : [...prev, entry],
    );
  }, []);
  const pop = useCallback(() => setEntries((prev) => prev.slice(0, -1)), []);
  const close = useCallback((key: string) => {
    setEntries((prev) => {
      const index = prev.findIndex((entry) => entry.key === key);
      return index === -1 ? prev : prev.slice(0, index);
    });
  }, []);
  const reset = useCallback(() => setEntries([]), []);
  return useMemo(
    () => ({ entries, push, pop, close, reset }),
    [entries, push, pop, close, reset],
  );
}

export interface PanelStackApi {
  /** 0 while the root panel is showing. */
  depth: number;
  push: (entry: PanelStackEntry) => void;
  pop: () => void;
  /**
   * Removes the level pushed under `key` and every level above it; a no-op when
   * it is not on the stack. For a pusher whose subject just went away — a
   * `Group` unmounting because its list item was removed — so the user is not
   * left on a page about something that no longer exists.
   */
  close: (key: string) => void;
  /** Back to the root in one step — for a host closing and reopening the panel. */
  reset: () => void;
}

export const PanelStackContext = createContext<PanelStackApi | null>(null);

/**
 * The panel stack a contribution pushes onto.
 *
 * It is published through CONTEXT rather than passed down because the third
 * consumer needs it that way: custom-columns' per-field editor is a nested
 * contribution rendered inside someone else's section, and has no prop path back
 * to whichever chrome is hosting the panel. Throws when there is no stack, which
 * is the honest answer — a component that pushes a sub-panel cannot render
 * correctly in a host that has nowhere to push it, and a silent no-op would show
 * as a dead click.
 */
export function usePanelStack(): PanelStackApi {
  const api = useContext(PanelStackContext);
  if (!api) {
    throw new Error(
      "usePanelStack() requires a <ControlPanel.Stack> ancestor. Panels rendered " +
        "through ControlPanelPopover already have one.",
    );
  }
  return api;
}
