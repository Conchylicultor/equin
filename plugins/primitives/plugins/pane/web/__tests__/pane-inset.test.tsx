import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import type { LoadedPlugin } from "@plugins/framework/plugins/web-sdk/core";
import {
  Pane,
  PaneChrome,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { paneHeaderContributions } from "../header-slot";
import { PaneLayoutContext } from "../maximize-context";
import { SurfaceChromeContext } from "../surface-chrome-context";
import { Pane as PaneSlots } from "../slots";
import { createTestSurfaceStore, TestSurface } from "../testing";

// `inset="content"` gives a pane ONE edge for its header title, a DataView's
// toolbar and its content. jsdom resolves no custom properties and no container
// queries, so what is pinned is the mechanism: the root is the container and
// publishes `--pane-inset`, the header pads by it (keeping the floating-bar
// reserve when it holds one), the default pane is untouched, and the header and
// title carry their `data-part`s.

const panePlugin = {
  id: "primitives.pane",
  description: "pane",
  contributions: paneHeaderContributions,
  slots: PaneSlots,
} as unknown as LoadedPlugin;

const app = defineApp({
  id: "inset",
  name: "Inset",
  basePath: "/inset",
  icon: symbol("science"),
});
const pane = Pane.define({
  route: defineRoute({ id: "inset-pane", segment: "" }),
  app,
  appIndex: true,
  component: () => null,
  title: "Inset title",
});
const hostPlugin = {
  id: "inset.host",
  description: "host",
  contributions: [Pane.Register({ pane })],
  slots: { pane },
} as unknown as LoadedPlugin;

const CONTAINER = "[container-type:inline-size]";
const PUBLISH = "[--pane-inset:var(--content-inset)]";

let store: PaneStore;

function mount(
  props: { inset?: "chrome" | "content" | "document"; header?: "card" },
  wrap: (node: ReactNode) => ReactNode = (n) => n,
) {
  return render(
    <TestSurface
      store={store}
      plugins={[panePlugin, hostPlugin]}
      basePath={app.basePath}
    >
      {wrap(
        <PaneChrome pane={pane} {...props}>
          body
        </PaneChrome>,
      )}
    </TestSurface>,
  );
}

function part(container: HTMLElement, name: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-part="${name}"]`);
  if (el === null) throw new Error(`no [data-part="${name}"]`);
  return el;
}

/** The PaneChrome root: the nearest ancestor of the header that holds the body. */
function root(container: HTMLElement): HTMLElement {
  let el: HTMLElement | null = part(container, "pane.header");
  while (el && !(el.textContent ?? "").includes("body")) el = el.parentElement;
  if (el === null) throw new Error("no pane root");
  return el;
}

/** The header as the surface's top-right bar: it reserves the floating bar. */
function atTopRight(node: ReactNode): ReactNode {
  return (
    <SurfaceChromeContext.Provider value={{ contentOwnsTopChrome: true }}>
      <PaneLayoutContext.Provider
        value={{ onDoubleClickHeader: () => {}, atSurfaceEnd: true }}
      >
        {node}
      </PaneLayoutContext.Provider>
    </SurfaceChromeContext.Provider>
  );
}

describe("PaneChrome inset", () => {
  beforeEach(() => {
    store = createTestSurfaceStore({ live: false });
  });
  afterEach(cleanup);

  it("marks the header and the title with their data-parts", () => {
    const { container } = mount({});
    const title = part(container, "pane.title");
    expect(title.textContent).toBe("Inset title");
    expect(part(container, "pane.header").contains(title)).toBe(true);
  });

  it("leaves a default pane exactly as it was", () => {
    const { container } = mount({});
    const header = part(container, "pane.header");
    expect(header.className).toContain("px-chrome-pane");
    expect(root(container).className).not.toContain(CONTAINER);
    expect(root(container).className).not.toContain(PUBLISH);
  });

  it('inset="content" makes the root the container that publishes the inset', () => {
    const { container } = mount({ inset: "content" });
    const r = root(container);
    expect(r.className).toContain(CONTAINER);
    expect(r.className).toContain(PUBLISH);
  });

  it('inset="content" leaves the header on its own tier inset (flush left)', () => {
    const { container } = mount({ inset: "content" });
    expect(part(container, "pane.header").className).toContain(
      "px-chrome-pane",
    );
  });

  it("keeps the floating-bar reserve on a content-inset header that holds it", () => {
    const { container } = mount({ inset: "content" }, atTopRight);
    const header = part(container, "pane.header");
    expect(header.className).toContain("pr-floating-bar-pane");
    expect(header.className).toContain("anchor-floating-bar-band");
  });

  it('inset="document" opens the region inside the body scroller, never on it or the header', () => {
    const { container } = mount({ inset: "document" });
    const header = part(container, "pane.header");
    expect(header.className).not.toContain("rail-document");
    // The header stands on the document edge too (one token, no jog).
    expect(header.className).toContain("pane-header-document");
    const owners = container.querySelectorAll(".rail-document");
    expect(owners).toHaveLength(1);
    expect(owners[0]?.textContent).toBe("body");
    // Not the scroller itself: a sticky offset counts from a scroller's padding
    // edge, so the region is a box inside it, filling it.
    const region = owners[0] as HTMLElement;
    expect(region.className).toContain("min-h-full");
    expect(region.parentElement?.className ?? "").not.toContain(
      "rail-document",
    );
    // Only the body's region: the root publishes no pane-wide inset.
    expect(root(container).className).not.toContain(PUBLISH);
  });

  it("a default pane opens no document region", () => {
    const { container } = mount({});
    expect(container.querySelector(".rail-document")).toBeNull();
    expect(part(container, "pane.header").className).not.toContain(
      "pane-header-document",
    );
  });

  it("a card header keeps its own row inset; only the root changes", () => {
    const { container } = mount({ inset: "content", header: "card" });
    expect(part(container, "pane.header").className).toContain(
      "px-chrome-pane-card",
    );
    expect(root(container).className).toContain(CONTAINER);
  });
});
