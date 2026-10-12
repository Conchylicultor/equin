import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { locationKey, type ExplorerLocation } from "../../core";

/**
 * How a file browser moves: where it is, and the moves it can make. A routed
 * explorer (the `/files` app) answers from the pane route, so back / forward
 * are the browser history and every location is a link (`to` / `fileTo`
 * return `LinkTarget`s, so ⌘/middle-click opens one in a new browser tab); an
 * embedded one keeps its own stack ({@link useLocalNavigator}) and its moves
 * are plain actions.
 *
 * A move is an `Activation`, never a void call: a control spreads it
 * (`activationProps`), a keyboard path runs it (`runActivation`).
 */
export interface ExplorerNavigator {
  location: ExplorerLocation;
  /** Listing another folder (a new history entry). Clears the open file unless given. */
  to: (dir: string, open?: string | null) => Activation;
  /** Opening a file beside the listing, or closing it (`null`). */
  fileTo: (path: string | null) => Activation;
  /** Back / forward walk the history: actions, not places, so not links. */
  back: () => void;
  forward: () => void;
  canBack: boolean;
  canForward: boolean;
}

interface Stacks {
  back: ExplorerLocation[];
  forward: ExplorerLocation[];
  current: ExplorerLocation | null;
}

/** Fold one observed location into the stacks: a step back, forward, or a new entry. */
function observe(stacks: Stacks, next: ExplorerLocation): Stacks {
  const { back, forward, current } = stacks;
  if (current === null) return { back, forward, current: next };
  const key = locationKey(next);
  if (key === locationKey(current)) return stacks;
  const prev = back[back.length - 1];
  if (prev && locationKey(prev) === key) {
    return {
      back: back.slice(0, -1),
      forward: [...forward, current],
      current: next,
    };
  }
  const ahead = forward[forward.length - 1];
  if (ahead && locationKey(ahead) === key) {
    return {
      back: [...back, current],
      forward: forward.slice(0, -1),
      current: next,
    };
  }
  return { back: [...back, current], forward: [], current: next };
}

/**
 * What a routed explorer remembers of the history it walked, per surface (an
 * app tab). The browser history itself cannot be asked "is there a previous
 * entry?", so the explorer mirrors the locations it has shown, in order, and
 * reads each new one as a step back, a step forward, or a new entry. Held at
 * module level so it survives the remount every folder change causes.
 */
const routedStacks = new Map<string, Stacks>();
const routedListeners = new Set<() => void>();
const NO_STACKS: Stacks = { back: [], forward: [], current: null };

function subscribeRouted(listener: () => void): () => void {
  routedListeners.add(listener);
  return () => routedListeners.delete(listener);
}

function recordRouted(surface: string, location: ExplorerLocation): void {
  const before = routedStacks.get(surface) ?? NO_STACKS;
  const after = observe(before, location);
  if (after === before) return;
  routedStacks.set(surface, after);
  for (const l of routedListeners) l();
}

/**
 * Whether back / forward lead anywhere, for a routed explorer showing
 * `location` on this surface.
 */
export function useRoutedHistory(location: ExplorerLocation): {
  canBack: boolean;
  canForward: boolean;
} {
  const surface = useSurfaceTabId() ?? "";
  const { dir, open } = location;
  useEffect(() => {
    recordRouted(surface, { dir, open });
  }, [surface, dir, open]);
  const stacks = useSyncExternalStore(
    subscribeRouted,
    () => routedStacks.get(surface) ?? NO_STACKS,
    () => NO_STACKS,
  );
  return {
    canBack: stacks.back.length > 0,
    canForward: stacks.forward.length > 0,
  };
}

/** An explorer that keeps its own location and history (embedded use). */
export function useLocalNavigator(
  initial: ExplorerLocation,
): ExplorerNavigator {
  const [stacks, setStacks] = useState<Stacks>({
    back: [],
    forward: [],
    current: initial,
  });
  const location = stacks.current ?? initial;
  const go = useCallback(
    (next: ExplorerLocation) => setStacks((s) => observe(s, next)),
    [],
  );
  const to = useCallback(
    (dir: string, open: string | null = null) =>
      () =>
        go({ dir, open }),
    [go],
  );
  const fileTo = useCallback(
    (open: string | null) => () =>
      setStacks((s) =>
        s.current === null ? s : { ...s, current: { ...s.current, open } },
      ),
    [],
  );
  const back = useCallback(
    () =>
      setStacks((s) => {
        const prev = s.back[s.back.length - 1];
        return prev ? observe(s, prev) : s;
      }),
    [],
  );
  const forward = useCallback(
    () =>
      setStacks((s) => {
        const ahead = s.forward[s.forward.length - 1];
        return ahead ? observe(s, ahead) : s;
      }),
    [],
  );
  return useMemo(
    () => ({
      location,
      to,
      fileTo,
      back,
      forward,
      canBack: stacks.back.length > 0,
      canForward: stacks.forward.length > 0,
    }),
    [location, to, fileTo, back, forward, stacks],
  );
}
