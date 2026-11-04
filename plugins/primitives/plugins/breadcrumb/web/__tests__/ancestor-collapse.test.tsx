import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { BreadcrumbSlots } from "../slots";
import { Breadcrumb } from "../internal/breadcrumb";

/**
 * The fold decision against a scripted layout: jsdom lays nothing out, so each
 * box's width comes from the model below, and `ResizeObserver` is a fake the
 * test fires by hand — per observed element, as the browser does.
 */

const plugin = {
  id: "breadcrumb-test",
  description: "breadcrumb fixture",
  contributions: [],
  slots: BreadcrumbSlots,
} as unknown as LoadedPlugin;

/**
 * The scripted layout: a left-packed row. Each visible crumb unit (crumb +
 * separator + gap) is `crumbUnit` wide, the overflow crumb `foldUnit`, and the
 * leaf takes its natural width or what the room leaves after everything
 * before it.
 */
const layout = {
  room: 500,
  crumbUnit: 60,
  foldUnit: 30,
  leaf: 100,
};

const LEAF = "data-breadcrumb-leaf";

function isRoot(el: Element): boolean {
  return el.querySelector(":scope > [" + LEAF + "]") !== null;
}

function isPrefix(el: Element): boolean {
  return el.nextElementSibling?.hasAttribute(LEAF) === true;
}

function prefixWidth(prefix: Element | null): number {
  if (!prefix || prefix.hasAttribute(LEAF)) return 0;
  const fold = prefix.querySelector("[data-crumb-fold]") ? layout.foldUnit : 0;
  return (
    fold +
    layout.crumbUnit * prefix.querySelectorAll("[data-crumb-index]").length
  );
}

function leafBox(leaf: Element): number {
  const before = prefixWidth(leaf.parentElement!.firstElementChild);
  return Math.max(0, Math.min(layout.leaf, layout.room - before));
}

function box(el: Element): { left: number; right: number } {
  if (el.hasAttribute(LEAF)) {
    const left = prefixWidth(el.parentElement!.firstElementChild);
    return { left, right: left + leafBox(el) };
  }
  if (isRoot(el)) return { left: 0, right: layout.room };
  if (isPrefix(el)) return { left: 0, right: prefixWidth(el) };
  if (el.hasAttribute("data-crumb-fold"))
    return { left: 0, right: layout.foldUnit };
  if (el.hasAttribute("data-crumb-index")) {
    const prefix = el.closest("[data-crumb-index]")!.parentElement!;
    const crumbs = Array.from(prefix.querySelectorAll("[data-crumb-index]"));
    const fold = prefix.querySelector("[data-crumb-fold]")
      ? layout.foldUnit
      : 0;
    const left = fold + layout.crumbUnit * crumbs.indexOf(el);
    return { left, right: left + layout.crumbUnit };
  }
  return { left: 0, right: 0 };
}

function widthOf(el: Element): number {
  const { left, right } = box(el);
  return right - left;
}

/** Every live fake observer, with the elements it watches. */
const observers = new Set<{ cb: () => void; targets: Set<Element> }>();

class FakeResizeObserver {
  private entry: { cb: () => void; targets: Set<Element> };
  constructor(cb: () => void) {
    this.entry = { cb, targets: new Set() };
    observers.add(this.entry);
  }
  observe(el: Element) {
    this.entry.targets.add(el);
  }
  unobserve(el: Element) {
    this.entry.targets.delete(el);
  }
  disconnect() {
    observers.delete(this.entry);
  }
}

/** The browser reporting that `el` changed size. */
function resized(el: Element) {
  for (const o of observers) if (o.targets.has(el)) o.cb();
}

// `scrollWidth` / `clientWidth` live on Element.prototype, `offsetWidth` on
// HTMLElement.prototype: each is shadowed on HTMLElement.prototype and the own
// descriptor (if any) put back afterwards.
const saved: (PropertyDescriptor | undefined)[] = [];
const realRect = HTMLElement.prototype.getBoundingClientRect;
const PROPS = ["scrollWidth", "clientWidth", "offsetWidth"] as const;

beforeEach(() => {
  Object.assign(layout, { room: 500, leaf: 100 });
  globalThis.ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver;
  for (const prop of PROPS) {
    saved.push(Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        if (prop === "scrollWidth" && this.hasAttribute(LEAF))
          return layout.leaf;
        return widthOf(this);
      },
    });
  }
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const { left, right } = box(this);
    const width = right - left;
    return {
      left,
      right,
      width,
      top: 0,
      bottom: 20,
      height: 20,
    } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  observers.clear();
  PROPS.forEach((prop, i) => {
    const own = saved[i];
    if (own) Object.defineProperty(HTMLElement.prototype, prop, own);
    else
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
        prop
      ];
  });
  saved.length = 0;
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

const noop = () => {};
const SEGMENTS = [
  { key: "a", label: "alpha", activation: noop },
  { key: "b", label: "beta", activation: noop },
  { key: "c", label: "gamma" },
];
const DEEP = [
  { key: "a", label: "alpha", activation: noop },
  { key: "b", label: "beta", activation: noop },
  { key: "c", label: "gamma", activation: noop },
  { key: "d", label: "delta", activation: noop },
  { key: "e", label: "epsilon", activation: noop },
  { key: "f", label: "zeta" },
];

function renderTrail(segments = SEGMENTS) {
  return render(
    <PluginProvider plugins={[plugin]}>
      <Breadcrumb segments={segments} />
    </PluginProvider>,
  );
}

function leaf(): HTMLElement {
  return document.querySelector("[data-breadcrumb-leaf]") as HTMLElement;
}

function root(): HTMLElement {
  return leaf().parentElement!;
}

function folded(): boolean {
  return screen.queryByLabelText(/^Show the/) !== null;
}

/** The ancestors drawn as crumbs, by label. */
function visible(segments = DEEP): string[] {
  return segments
    .slice(0, -1)
    .map((s) => s.label as string)
    .filter((label) => screen.queryByText(label) !== null);
}

function foldLabel(): string | null {
  return (
    screen.queryByLabelText(/^Show the/)?.getAttribute("aria-label") ?? null
  );
}

const levels = (n: number) => `Show the ${n} levels above this one`;

describe("Breadcrumb ancestor fold", () => {
  it("shows every ancestor when the trail fits", () => {
    renderTrail();
    expect(folded()).toBe(false);
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  it("folds when the leaf would have to truncate", () => {
    layout.room = 150;
    renderTrail();
    expect(folded()).toBe(true);
  });

  it("unfolds when the leaf shrinks back while the room stays the same", async () => {
    // First layout with a transient wide leaf (a fallback font before the web
    // font lands): it does not fit, so an ancestor folds.
    layout.leaf = 400;
    renderTrail();
    expect(folded()).toBe(true);

    // The font lands: the leaf is narrow again, the trail's own width never
    // moved. Only the leaf reports a resize — and that alone must re-decide.
    layout.leaf = 100;
    act(() => resized(leaf()));
    await waitFor(() => expect(folded()).toBe(false));
  });

  it("unfolds when the room grows", async () => {
    layout.room = 150;
    renderTrail();
    expect(folded()).toBe(true);
    layout.room = 600;
    act(() => resized(root()));
    await waitFor(() => expect(folded()).toBe(false));
  });

  it("stays folded while the room is still short", async () => {
    layout.room = 150;
    renderTrail();
    expect(folded()).toBe(true);
    act(() => resized(leaf()));
    // Give a scheduled frame the chance to (wrongly) unfold.
    await new Promise((r) => setTimeout(r, 50));
    expect(folded()).toBe(true);
  });

  describe("partial fold", () => {
    it("shows every ancestor of a deep trail when it fits", () => {
      layout.room = 500;
      renderTrail(DEEP);
      expect(folded()).toBe(false);
      expect(visible()).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
    });

    it("folds only the oldest ancestors that must go", () => {
      // 5 crumbs (300) + leaf (100) = 400 > 270; folding 3 leaves
      // 30 + 120 + 100 = 250, folding 2 would leave 310.
      layout.room = 270;
      renderTrail(DEEP);
      expect(foldLabel()).toBe(levels(3));
      expect(visible()).toEqual(["delta", "epsilon"]);
      expect(screen.getByText("zeta")).toBeTruthy();
    });

    it("brings back exactly the ancestors that fit as the room grows", async () => {
      layout.room = 270;
      renderTrail(DEEP);
      expect(foldLabel()).toBe(levels(3));

      // Free space 40: not enough for gamma (60) plus the margin.
      layout.room = 290;
      act(() => resized(root()));
      await new Promise((r) => setTimeout(r, 50));
      expect(foldLabel()).toBe(levels(3));

      // Free space 64: gamma (60) fits with the margin, beta does not.
      layout.room = 314;
      act(() => resized(root()));
      await waitFor(() => expect(foldLabel()).toBe(levels(2)));
      expect(visible()).toEqual(["gamma", "delta", "epsilon"]);

      // Plenty: everything comes back, overflow crumb included.
      layout.room = 600;
      act(() => resized(root()));
      await waitFor(() => expect(folded()).toBe(false));
      expect(visible()).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
    });

    it("folds further when the room shrinks", async () => {
      layout.room = 500;
      renderTrail(DEEP);
      expect(folded()).toBe(false);
      layout.room = 270;
      act(() => resized(root()));
      await waitFor(() => expect(foldLabel()).toBe(levels(3)));
      expect(visible()).toEqual(["delta", "epsilon"]);
    });
  });
});
