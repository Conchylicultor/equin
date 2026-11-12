import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";

/**
 * What a revived subtree lets its kept scrollers do: restore an offset saved
 * earlier in THIS document — once per key (by the scroller that first claims
 * it; the same element may claim again, so a StrictMode effect re-run still
 * restores), and only while the subtree still shows what it was revived on.
 */
interface Revival {
  claim(key: string, el: HTMLElement): boolean;
}

const RevivalContext = createContext<Revival | null>(null);

/**
 * Marks a subtree whose mount is a restoration of one that was unloaded — an
 * in-app tab mounted again after it was dropped to save memory. A kept scroller
 * ({@link useScrollAcrossReload}) under it then comes back to the offset it
 * saved when it unmounted, exactly as after a reload; without it, an offset
 * saved in this same document is an in-app revisit, which opens at the top.
 *
 * The revival covers what the subtree shows when it mounts, and nothing after:
 * `showing` names it (a tab passes its route's pane instances), and the moment
 * it changes the scope closes for good — a pane the reader then opens is
 * navigation again, which opens at the top. It closes in a layout effect, so
 * before any scroller the navigation mounts can claim. `revived={false}` (a
 * first mount) provides nothing.
 */
export function ScrollRevival({
  revived,
  showing,
  children,
}: {
  revived: boolean;
  showing: string;
  children: ReactNode;
}) {
  const [scope] = useState(() => {
    const claimed = new Map<string, HTMLElement>();
    let open = true;
    const revival: Revival = {
      claim(key, el) {
        if (!open) return false;
        const by = claimed.get(key);
        if (by !== undefined) return by === el;
        claimed.set(key, el);
        return true;
      },
    };
    return {
      revival,
      revivedOn: showing,
      close: () => {
        open = false;
        claimed.clear();
      },
    };
  });
  useLayoutEffect(() => {
    if (showing !== scope.revivedOn) scope.close();
  }, [showing, scope]);
  return (
    <RevivalContext.Provider value={revived ? scope.revival : null}>
      {children}
    </RevivalContext.Provider>
  );
}

/** The revival scope a scroller mounts in, if any (see {@link ScrollRevival}). */
export function useScrollRevival(): Revival | null {
  return useContext(RevivalContext);
}
