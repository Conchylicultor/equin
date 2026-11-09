import { flushSync } from "react-dom";
import { peekRoute } from "@plugins/primitives/plugins/pane/web";
import {
  openTransitionHolds,
  prefersReducedMotion,
  type TransitionHolds,
} from "@plugins/primitives/plugins/css/plugins/motion/web";
import "./morph.css";

/**
 * The pane → app morph: a cross-app Expand run as a view transition in which
 * the pane grows from its box into its place in the app that replaces this one.
 *
 * The old app is captured as a picture, the navigation commits synchronously
 * inside the transition (`flushSync`) and the new app — a different component
 * tree, mounted from scratch — is the live new state. Three elements are
 * matched across the two apps by name, for the length of one morph only (so
 * several visible tabs can never carry duplicate names):
 *
 *  - the pane — the box the user expanded, and the LEAF pane of the new route
 *    (not "the same pane id": a peeked file lands on Files' folder pane);
 *  - its header title, which glides from one header to the other;
 *  - the app sidebar, which cross-fades in place (absent on one side → it
 *    leaves or arrives with its app).
 *
 * Only elements that persist while the new app loads are named — the pane box,
 * its title cell, the sidebar container. Removing a named element mid-flight
 * aborts the transition; a pane's loading → content swap happens INSIDE its box.
 *
 * Design and prototype: research/2026-10-29-apps-core-pane-morph.md.
 */

const PANE = "pane-morph";
const TITLE = "pane-morph-title";
const SIDEBAR = "pane-morph-sidebar";
/** Scopes the morph's CSS to its own transition (`morph.css`). */
const ACTIVE_ATTR = "data-pane-morph";

let running = false;

export function morphPane(from: HTMLElement, open: () => void): void {
  // The tab container is the one element that survives the app swap — the tab
  // keeps its tabId and only its app changes — so both sides are looked up in it.
  const tab = from.closest<HTMLElement>("[data-tab-id]");
  if (
    running ||
    tab === null ||
    typeof document.startViewTransition !== "function" ||
    prefersReducedMotion()
  ) {
    open();
    return;
  }

  running = true;
  const named: HTMLElement[] = [];
  const name = (el: Element | null, value: string): void => {
    if (!(el instanceof HTMLElement)) return;
    el.style.viewTransitionName = value;
    named.push(el);
  };
  const clear = (): void => {
    for (const el of named.splice(0)) el.style.viewTransitionName = "";
  };

  name(from, PANE);
  name(from.querySelector(TITLE_SELECTOR), TITLE);
  name(tab.querySelector(SIDEBAR_SELECTOR), SIDEBAR);
  // A stamped origin (`morphOriginProps`: a map block) grows from its middle
  // (morph.css): its picture and the new pane's are centred in the box.
  document.documentElement.setAttribute(
    ACTIVE_ATTR,
    from.hasAttribute("data-morph-origin") ? "centred" : "",
  );

  // A surface the new app mounts that is not presentable yet (a `Loading`
  // state, a map before its tiles) holds the morph until it is — bounded — so
  // the morph grows into content, not a blank or tile-less box. Opened around
  // the update (where those surfaces mount), waited on once the transition is
  // ready: inside the update the browser suppresses rendering, and a map draws
  // its tiles in animation frames — it could never get there.
  let holds: TransitionHolds | null = null;
  const transition = document.startViewTransition(async () => {
    clear();
    holds = openTransitionHolds();
    flushSync(open);
    // An app not loaded yet (first visit, a lazy tier) mounts its pane a few
    // frames after the commit: the transition waits for the box (bounded), or
    // there would be nothing to grow into.
    const leaf = await leafPaneBoxWhenMounted(tab);
    name(leaf, PANE);
    name(leaf?.querySelector(TITLE_SELECTOR) ?? null, TITLE);
    name(tab.querySelector(SIDEBAR_SELECTOR), SIDEBAR);
  });

  const done = (): void => {
    clear();
    document.documentElement.removeAttribute(ACTIVE_ATTR);
    running = false;
  };
  // A transition the browser skips on its own (another one started, the page
  // hid) rejects `ready` with an AbortError: the navigation still ran, nothing
  // to report. Anything else — duplicate names, a throwing navigation — is ours,
  // and surfaces here. `finished` rejects with that same error, so it only
  // cleans up. Either way the hold window is closed.
  void transition.ready.then(
    async () => {
      // Every animation stands on its first frame — the old picture, the new
      // one still transparent — while the new app draws itself live under it.
      const animations = document
        .getAnimations()
        .filter(isViewTransitionAnimation);
      for (const a of animations) a.pause();
      await holds?.settled(HOLD_BUDGET_MS);
      for (const a of animations) a.play();
    },
    async (err: unknown) => {
      await holds?.settled(0);
      if (err instanceof DOMException && err.name === "AbortError") return;
      throw err;
    },
  );
  void transition.finished.then(done, () => done());
}

/** An animation of this document's view-transition pseudo-elements. */
function isViewTransitionAnimation(a: Animation): boolean {
  const effect = a.effect;
  return (
    effect instanceof KeyframeEffect &&
    effect.target === document.documentElement &&
    (effect.pseudoElement?.startsWith("::view-transition") ?? false)
  );
}

const TITLE_SELECTOR = '[data-part="pane.title"]';
const SIDEBAR_SELECTOR = '[data-slot="sidebar-container"]';

/**
 * How long the new app's surfaces may hold the new picture (a `Loading` state
 * waiting on its data, a map's tiles from Google's servers) before the morph
 * runs anyway — the screen stays on the old picture meanwhile.
 */
const HOLD_BUDGET_MS = 1500;

/** How long the new app may take to mount its leaf pane before the morph gives up waiting (a lazy app load, not our own work). */
const LEAF_WAIT_MS = 1500;

function leafPaneBoxWhenMounted(tab: HTMLElement): Promise<HTMLElement | null> {
  const now = leafPaneBox(tab);
  if (now !== null) return Promise.resolve(now);
  return new Promise((resolve) => {
    const settle = (box: HTMLElement | null): void => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(box);
    };
    const observer = new MutationObserver(() => {
      const box = leafPaneBox(tab);
      if (box !== null) settle(box);
    });
    const timer = setTimeout(
      () => settle(leafPaneBox(tab, true)),
      LEAF_WAIT_MS,
    );
    observer.observe(tab, { childList: true, subtree: true });
  });
}

/** The box of the pane the new route ends on, inside `tab` — the last one in DOM order (miller: rightmost). */
function leafPaneBox(tab: HTMLElement, lenient = false): HTMLElement | null {
  const leaf = peekRoute().at(-1);
  const all = [...tab.querySelectorAll<HTMLElement>("[data-pane-id]")];
  // An app's index pane (bare `/places`) is the route's EMPTY chain: the pane
  // on screen is the leaf.
  if (leaf === undefined) return all.at(-1) ?? null;
  const named = all.filter((box) => box.dataset.paneId === leaf.paneId).at(-1);
  // After the wait: whatever pane the new app drew last beats nothing to grow into.
  return named ?? (lenient ? (all.at(-1) ?? null) : null);
}
