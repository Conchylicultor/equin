import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { morphPane } from "../internal/morph";

// The morph names the expanded pane, its title and the app sidebar on the way
// out; commits the navigation inside the transition; names the new route's leaf
// pane, its title and the new sidebar on the way in; and clears every name once
// the transition is over. Without view transitions it is the plain navigation.

const route = vi.hoisted(() => ({ leaf: "target" }));
const motion = vi.hoisted(() => ({ reduce: false }));
vi.mock("@plugins/primitives/plugins/css/plugins/motion/web", () => ({
  prefersReducedMotion: () => motion.reduce,
}));
vi.mock("@plugins/primitives/plugins/pane/web", () => ({
  peekRoute: () => [{ paneId: "host-list" }, { paneId: route.leaf }],
}));

const APP_A = `
  <div data-slot="sidebar-container" id="side-a"></div>
  <div data-pane-id="host-list"></div>
  <div data-pane-id="peek" id="from"><div data-part="pane.title" id="title-a"></div></div>`;
const APP_B = `
  <div data-slot="sidebar-container" id="side-b"></div>
  <div data-pane-id="target" id="to"><div data-part="pane.title" id="title-b"></div></div>`;

let tab: HTMLElement;
const byId = (id: string): HTMLElement => document.getElementById(id)!;
const names = (...ids: string[]): string[] =>
  ids.map((id) => byId(id).style.viewTransitionName);

beforeEach(() => {
  document.body.innerHTML = `<div data-tab-id="t1" id="tab">${APP_A}</div>`;
  tab = byId("tab");
  motion.reduce = false;
});

afterEach(() => {
  Reflect.deleteProperty(document, "startViewTransition");
});

/** A synchronous stand-in for the browser: runs the update, hands back settled promises. */
function stubViewTransition(onUpdate: () => void) {
  const calls: { namesBefore: string[] }[] = [];
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: (update: () => void) => {
      calls.push({ namesBefore: names("from", "title-a", "side-a") });
      update();
      onUpdate();
      return {
        ready: Promise.resolve(),
        finished: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
      };
    },
  });
  return calls;
}

const swapToAppB = (): void => {
  tab.innerHTML = APP_B;
};

describe("morphPane", () => {
  it("is the plain navigation without view transitions", () => {
    const open = vi.fn(swapToAppB);
    morphPane(byId("from"), open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(names("to", "title-b", "side-b")).toEqual(["", "", ""]);
  });

  it("is the plain navigation under reduced motion", () => {
    motion.reduce = true;
    const calls = stubViewTransition(() => {});
    const open = vi.fn(swapToAppB);
    morphPane(byId("from"), open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("names both sides and clears them once the transition is over", async () => {
    let namesAfterUpdate: string[] = [];
    const calls = stubViewTransition(() => {
      namesAfterUpdate = names("to", "title-b", "side-b");
    });
    const open = vi.fn(swapToAppB);

    morphPane(byId("from"), open);

    expect(open).toHaveBeenCalledTimes(1);
    expect(calls[0]!.namesBefore).toEqual([
      "pane-morph",
      "pane-morph-title",
      "pane-morph-sidebar",
    ]);
    expect(namesAfterUpdate).toEqual([
      "pane-morph",
      "pane-morph-title",
      "pane-morph-sidebar",
    ]);
    expect(document.documentElement.hasAttribute("data-pane-morph")).toBe(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(names("to", "title-b", "side-b")).toEqual(["", "", ""]);
    expect(document.documentElement.hasAttribute("data-pane-morph")).toBe(
      false,
    );
  });

  it("still navigates when the new route's leaf is not on screen", () => {
    route.leaf = "not-loaded-yet";
    stubViewTransition(() => {});
    const open = vi.fn(swapToAppB);
    morphPane(byId("from"), open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(byId("to").style.viewTransitionName).toBe("");
    route.leaf = "target";
  });

  it("is the plain navigation outside a tab", () => {
    document.body.innerHTML = APP_A;
    const calls = stubViewTransition(() => {});
    const open = vi.fn();
    morphPane(byId("from"), open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});
