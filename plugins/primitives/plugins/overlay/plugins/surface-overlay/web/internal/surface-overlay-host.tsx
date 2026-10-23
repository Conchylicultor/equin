import {
  createContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * What a {@link SurfaceOverlay} reaches its host through: `attach(container)`
 * adopts the overlay's container into the host's box and returns the detach.
 * One object for the host's whole life, so the context value is stable and
 * mounting a host never re-renders its subtree.
 *
 * Why not the host's ref. A child's layout effects run BEFORE its parent's ref
 * is attached, so an overlay mounted in the same commit as its host (a deep
 * link straight to an overlaying pane) would read an empty ref. `attach` queues
 * such a container and the host adopts it in its own layout effect, later in
 * the same commit — still before paint.
 *
 * `null` means "nobody declared a surface above me", which is a bug at the
 * overlay, not a mode to degrade into — see the throw in `<SurfaceOverlay>`.
 */
export interface SurfaceOverlayHostHandle {
  attach: (container: HTMLElement) => () => void;
}

export const SurfaceOverlayHostContext =
  createContext<SurfaceOverlayHostHandle | null>(null);

/**
 * Declares "overlays may fill this box" — one per surface, mounted by whoever
 * owns the surface's outer box (`apps-core/tab-surface`, once per app tab).
 *
 * It is a `relative` box, so the overlay's `absolute inset-0` resolves against
 * THIS element: the region below the tab bar and right of the app rail, under
 * every placement (docked / floating window / solo) because each of them hands
 * the tab a different outer box and this host is inside all of them.
 */
export function SurfaceOverlayHost({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state] = useState(() => {
    const pending = new Set<HTMLElement>();
    const handle: SurfaceOverlayHostHandle = {
      attach: (container) => {
        const el = ref.current;
        if (el) el.appendChild(container);
        else pending.add(container);
        return () => {
          pending.delete(container);
          container.remove();
        };
      },
    };
    return { pending, handle };
  });
  // Runs after every child's layout effect in the commit that mounts the host:
  // adopt the overlays that asked before the box existed.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) throw new Error("SurfaceOverlayHost: its box is not mounted.");
    for (const container of state.pending) el.appendChild(container);
    state.pending.clear();
  }, [state]);
  return (
    <SurfaceOverlayHostContext value={state.handle}>
      <div ref={ref} className="relative size-full">
        {children}
      </div>
    </SurfaceOverlayHostContext>
  );
}
