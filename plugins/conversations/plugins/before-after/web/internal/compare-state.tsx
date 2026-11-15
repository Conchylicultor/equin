import { createContext, use, useMemo, useState, type ReactNode } from "react";
import type { SwipeCompareMode } from "@plugins/primitives/plugins/diff-view/plugins/swipe-compare/web";

/**
 * How one Before / after pane compares — the mode, the divider's place and
 * whether it is shown full screen — held once for the pane, so its header's
 * full-screen action, its viewer and the full-screen view all read the same
 * one: the mode and divider carry into full screen and back.
 */
export interface CompareState {
  mode: SwipeCompareMode;
  setMode: (mode: SwipeCompareMode) => void;
  at: number;
  setAt: (at: number) => void;
  fullScreen: boolean;
  setFullScreen: (open: boolean) => void;
}

const CompareStateContext = createContext<CompareState | null>(null);

/** Holds a pane's {@link CompareState}: swipe, centred, not full screen. */
export function CompareStateProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [mode, setMode] = useState<SwipeCompareMode>("swipe");
  const [at, setAt] = useState(0.5);
  const [fullScreen, setFullScreen] = useState(false);
  // The setters are stable (useState's), so the value moves only with state.
  const value = useMemo(
    () => ({ mode, setMode, at, setAt, fullScreen, setFullScreen }),
    [mode, at, fullScreen],
  );
  return <CompareStateContext value={value}>{children}</CompareStateContext>;
}

/** The enclosing pane's compare state. Throws outside a Before / after pane. */
export function useCompareState(): CompareState {
  const state = use(CompareStateContext);
  if (state === null)
    throw new Error(
      "useCompareState: read outside a Before / after pane (CompareStateProvider)",
    );
  return state;
}

/** The modes, in the order the control offers them. */
export const COMPARE_MODES: readonly {
  id: SwipeCompareMode;
  label: string;
}[] = [
  { id: "swipe", label: "Swipe" },
  { id: "side", label: "Side by side" },
  { id: "flip", label: "Flip" },
];
