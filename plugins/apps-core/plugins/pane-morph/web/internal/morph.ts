import { flushSync } from "react-dom";
import { peekRoute } from "@plugins/primitives/plugins/pane/web";
import { prefersReducedMotion } from "@plugins/primitives/plugins/css/plugins/motion/web";
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
  document.documentElement.setAttribute(ACTIVE_ATTR, "");

  const transition = document.startViewTransition(() => {
    clear();
    flushSync(open);
    const leaf = leafPaneBox(tab);
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
  // cleans up.
  void transition.ready.catch((err: unknown) => {
    if (err instanceof DOMException && err.name === "AbortError") return;
    throw err;
  });
  void transition.finished.then(done, () => done());
}

const TITLE_SELECTOR = '[data-part="pane.title"]';
const SIDEBAR_SELECTOR = '[data-slot="sidebar-container"]';

/** The box of the pane the new route ends on, inside `tab` — the last one in DOM order (miller: rightmost). */
function leafPaneBox(tab: HTMLElement): HTMLElement | null {
  const leaf = peekRoute().at(-1);
  if (leaf === undefined) return null;
  const boxes = [...tab.querySelectorAll<HTMLElement>("[data-pane-id]")].filter(
    (box) => box.dataset.paneId === leaf.paneId,
  );
  return boxes.at(-1) ?? null;
}
