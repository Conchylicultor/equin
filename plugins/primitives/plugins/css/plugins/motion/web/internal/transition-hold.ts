import { useLayoutEffect } from "react";

/**
 * Holding a view transition until what its new picture shows is drawn.
 *
 * A view transition's new picture is the live new state. A surface mounted by
 * its update that paints asynchronously — a `Loading` state waiting on data, a
 * map whose tiles arrive from the network a few hundred ms later — would make
 * the transition grow a blank or tile-less picture that fills in after. So
 * the transition's owner opens a window around its update
 * ({@link openTransitionHolds}); a surface not yet presentable holds it
 * ({@link useTransitionHold}) and lets go once it is; the owner awaits
 * {@link TransitionHolds.settled} before it lets the transition animate.
 * Not inside the update callback: the browser suppresses rendering there, so a
 * surface that paints in animation frames (a map's tiles) never would — the
 * pane morph waits with its animations paused on their first frame (the old
 * picture) instead.
 *
 * Outside a window a hold is nothing: a surface mounting on an ordinary
 * navigation never delays anything.
 */
export interface TransitionHolds {
  /**
   * Resolves once every hold taken in this window has been let go, or after
   * `budgetMs` (the surface's content comes from a peer we do not control —
   * the transition must not freeze the screen on a slow network). A hold
   * taken while it waits (a surface mounting a frame late) is waited for too;
   * the window closes when it resolves.
   */
  settled(budgetMs: number): Promise<void>;
}

let open: HoldWindow | null = null;

interface HoldWindow {
  holds: Set<symbol>;
  /** Called whenever a hold is let go. */
  onRelease: (() => void) | null;
}

/** Opens a hold window around a view transition's update. One at a time. */
export function openTransitionHolds(): TransitionHolds {
  const win: HoldWindow = { holds: new Set(), onRelease: null };
  open = win;
  return {
    settled(budgetMs) {
      return new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          win.onRelease = null;
          if (open === win) open = null;
          resolve();
        };
        const timer = setTimeout(finish, budgetMs);
        // Checked after the commit, not inside it: a commit that swaps one
        // unpresentable surface for another (a `Loading` for the map its data
        // reveals) runs the leaving one's cleanup BEFORE the arriving one's
        // layout effect — counted at once, the window would close between.
        win.onRelease = () => {
          queueMicrotask(() => {
            if (win.holds.size === 0) finish();
          });
        };
        win.onRelease();
      });
    },
  };
}

/**
 * Holds the open view transition (if any) while `pending`: it waits until
 * this surface is presentable. Taken in a layout effect, so a surface mounted
 * synchronously inside the transition's update holds it before the owner
 * starts waiting.
 */
export function useTransitionHold(pending: boolean): void {
  useLayoutEffect(() => (pending ? takeHold() : undefined), [pending]);
}

/**
 * Takes a hold on the open window, returning its release (nothing outside a
 * window). A plain function, not inlined in the hook: the React Compiler
 * treats a module binding read in a hook as a constant, and would read the
 * window again at release — by then closed and `null`.
 */
function takeHold(): (() => void) | undefined {
  const win = open;
  if (win === null) return undefined;
  const hold = Symbol("transition-hold");
  win.holds.add(hold);
  return () => {
    win.holds.delete(hold);
    win.onRelease?.();
  };
}
