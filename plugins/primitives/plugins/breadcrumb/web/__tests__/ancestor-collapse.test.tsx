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

/** The scripted layout: the room, and the natural widths of what fills it. */
const layout = {
  room: 500,
  openPrefix: 200,
  foldedPrefix: 30,
  gap: 4,
  leaf: 100,
};

function isFoldedPrefix(el: Element): boolean {
  return el.querySelector("[aria-label^='Show the']") !== null;
}

function prefixWidth(root: Element): number {
  const prefix = root.firstElementChild;
  if (!prefix || prefix.hasAttribute("data-breadcrumb-leaf")) return 0;
  return isFoldedPrefix(prefix) ? layout.foldedPrefix : layout.openPrefix;
}

/** Width the flex row hands the leaf: the room left, never more than it needs. */
function leafBox(leaf: Element): number {
  const root = leaf.parentElement!;
  return Math.max(
    0,
    Math.min(layout.leaf, layout.room - prefixWidth(root) - layout.gap),
  );
}

function widthOf(el: Element): number {
  if (el.hasAttribute("data-breadcrumb-leaf")) return leafBox(el);
  if (el.querySelector(":scope > [data-breadcrumb-leaf]")) return layout.room;
  if (el.nextElementSibling?.hasAttribute("data-breadcrumb-leaf"))
    return prefixWidth(el.parentElement!);
  return 0;
}

function rightOf(el: Element): number {
  if (el.hasAttribute("data-breadcrumb-leaf"))
    return prefixWidth(el.parentElement!) + layout.gap + leafBox(el);
  return widthOf(el);
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
        if (prop === "scrollWidth" && this.hasAttribute("data-breadcrumb-leaf"))
          return layout.leaf;
        return widthOf(this);
      },
    });
  }
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const right = rightOf(this);
    const width = widthOf(this);
    return {
      left: right - width,
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

function renderTrail() {
  return render(
    <PluginProvider plugins={[plugin]}>
      <Breadcrumb segments={SEGMENTS} />
    </PluginProvider>,
  );
}

function leaf(): HTMLElement {
  return document.querySelector("[data-breadcrumb-leaf]") as HTMLElement;
}

function folded(): boolean {
  return screen.queryByLabelText(/^Show the/) !== null;
}

describe("Breadcrumb ancestor fold", () => {
  it("shows every ancestor when the trail fits", () => {
    renderTrail();
    expect(folded()).toBe(false);
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  it("folds when the leaf would have to truncate", () => {
    layout.room = 250;
    renderTrail();
    expect(folded()).toBe(true);
  });

  it("unfolds when the leaf shrinks back while the room stays the same", async () => {
    // First layout with a transient wide leaf (a fallback font before the web
    // font lands): it does not fit, so the ancestors fold.
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
    layout.room = 250;
    const { container } = renderTrail();
    expect(folded()).toBe(true);
    layout.room = 600;
    const root = container.querySelector(
      ":scope [data-breadcrumb-leaf]",
    )!.parentElement!;
    act(() => resized(root));
    await waitFor(() => expect(folded()).toBe(false));
  });

  it("stays folded while the room is still short", async () => {
    layout.room = 250;
    renderTrail();
    expect(folded()).toBe(true);
    act(() => resized(leaf()));
    // Give a scheduled frame the chance to (wrongly) unfold.
    await new Promise((r) => setTimeout(r, 50));
    expect(folded()).toBe(true);
  });
});
