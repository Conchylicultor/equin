import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { LoadedPlugin } from "@plugins/framework/plugins/web-sdk/core";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import {
  defineRenderSlot,
  renderIsolated,
} from "@plugins/primitives/plugins/slot-render/web";
import {
  Pane,
  PaneChrome,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import type { PaneTitle } from "../pane";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { paneHeaderContributions } from "../header-slot";
import { PANE_TITLE_SLOT_ERROR } from "../components/pane-title-guard";
import { Pane as PaneSlots } from "../slots";
import { createTestSurfaceStore, TestSurface } from "../testing";

// One pane header is ONE slot, title included. These pin the facts that makes
// true and that nothing else in the suite would notice breaking: the pane
// contributes its own title item into every declared header, that item paints
// what `Pane.define({ title })` declares, `titleOnly` keeps it while dropping
// the ordinary items, and nothing can mount a second slot inside it.

// The guard rides the pane plugin's own contributions (`paneHeaderContributions`,
// below), exactly as in the browser: every header renders the title item —
// itself a render-slot contribution — under it, so each case also pins that the
// title item is not what trips it.

function ActionWidget() {
  return <span>an-action</span>;
}

// The pane plugin as the browser loads it: its `contributions` ARE the live
// array the declaration pass rewrites, so the title items exist only because a
// plugin declared a header slot (below) — the same path production takes.
const panePlugin = {
  id: "primitives.pane",
  description: "pane",
  contributions: paneHeaderContributions,
  slots: PaneSlots,
} as unknown as LoadedPlugin;

// A second slot someone might be tempted to render inside a title.
const SmuggledSlot = defineRenderSlot<{ component: () => null }>();
// A render slot that is a component's own internal list, declared as such.
const PartSlot = defineRenderSlot<{ component: () => null }>({
  partOfComponent: true,
});
// A plain slot painted once through renderIsolated — a breadcrumb's separator.
const PlainSlot = defineSlot<{ id: string; component: () => ReactNode }>();

function PlainSlotOnce() {
  const first = PlainSlot.useContributions()[0];
  return first
    ? renderIsolated(PlainSlot, first as unknown as Contribution, {})
    : null;
}

/**
 * One index pane per case, each in its own app (an app has at most one index
 * pane), so the pane is in the surface's match and its title has params.
 */
function headerCase(id: string, title?: PaneTitle<Record<string, never>>) {
  const app = defineApp({
    id: `hdr-${id}`,
    name: `Header ${id}`,
    basePath: `/${id}`,
    iconKey: "science",
  });
  const pane = Pane.define({
    route: defineRoute({ id: `hdr-${id}-pane`, segment: "" }),
    app,
    appIndex: true,
    component: () => null,
    title,
  });
  // The pane's own plugin: declaring the pane is what NAMES its header slot.
  const hostPlugin = {
    id: `hdr.${id}`,
    description: "host",
    contributions: [
      Pane.Register({ pane }),
      pane.Actions({ id: "act", component: ActionWidget }),
      SmuggledSlot({ id: "smuggled", component: () => null }),
      PartSlot({ id: "part", component: () => null }),
      PlainSlot({ id: "plain", component: () => <i>separator</i> }),
    ],
    slots: { pane, smuggled: SmuggledSlot, part: PartSlot, plain: PlainSlot },
  } as unknown as LoadedPlugin;
  return { pane, basePath: app.basePath, plugins: [panePlugin, hostPlugin] };
}

const titled = headerCase("titled", "A title");
const untitled = headerCase("untitled");
const pending = headerCase("pending", {
  useText: () => undefined,
  fallback: "Generic noun",
});
const rich = headerCase("rich", {
  useText: "Tab text",
  component: () => <b>rich-title</b>,
});
const withPart = headerCase("part", {
  useText: "Tab text",
  component: () => (
    <PartSlot.Render>{() => <span>own-part</span>}</PartSlot.Render>
  ),
});
const withPlain = headerCase("plain", {
  useText: "Tab text",
  component: () => <PlainSlotOnce />,
});
const smuggling = headerCase("smuggling", {
  useText: "Tab text",
  component: () => (
    <SmuggledSlot.Render>{() => <span>second-row</span>}</SmuggledSlot.Render>
  ),
});

let store: PaneStore;

function mount(
  c: ReturnType<typeof headerCase>,
  props: { titleOnly?: boolean } = {},
) {
  return render(
    <TestSurface store={store} plugins={c.plugins} basePath={c.basePath}>
      <PaneChrome pane={c.pane} {...props}>
        body
      </PaneChrome>
    </TestSurface>,
  );
}

/**
 * The header's one growing cell — `AdaptiveBar.Yield grow`, i.e. `fillClasses`.
 * Found by the classes because that pair IS the mechanism under test; a marker
 * attribute added for the test's benefit would pin nothing about the layout.
 */
function growingCell(container: HTMLElement): HTMLElement | null {
  const cells = [
    ...container.querySelectorAll<HTMLElement>("div.min-w-0.flex-1"),
  ];
  // The AdaptiveBar ROOT carries the same pair — it is its own row's grow cell —
  // and it is the only other one. It says so with `whitespace-nowrap`.
  return (
    cells.find((el) => !el.classList.contains("whitespace-nowrap")) ?? null
  );
}

describe("pane header", () => {
  beforeEach(() => {
    store = createTestSurfaceStore({ live: false });
  });
  afterEach(cleanup);

  it("renders the pane's declared title as a contribution of the header slot", () => {
    mount(titled);
    expect(screen.getByText("A title")).toBeTruthy();
    expect(screen.getByText("an-action")).toBeTruthy();
  });

  it("puts the title FIRST in natural order", () => {
    const { container } = mount(titled);
    const text = container.textContent ?? "";
    expect(text.indexOf("A title")).toBeLessThan(text.indexOf("an-action"));
  });

  it("renders no title for a pane that declares none", () => {
    const { container } = mount(untitled);
    expect(growingCell(container)?.textContent).toBe("");
    expect(screen.getByText("an-action")).toBeTruthy();
  });

  it("shows the fallback while the text hook yields nothing", () => {
    mount(pending);
    expect(screen.getByText("Generic noun")).toBeTruthy();
  });

  it("paints title.component in the header instead of the text", () => {
    const { container } = mount(rich);
    expect(screen.queryByText("Tab text")).toBeNull();
    expect(growingCell(container)?.textContent).toBe("rich-title");
  });

  // The title's cell GROWS (`min-w-0 flex-1` — a Fill), which is what puts the
  // row's slack between the title and the actions instead of in front of both.
  // A pane with no title must land its actions in the same place as one with a
  // title, and that holds only if the cell is still there, still growing, when
  // the item inside it renders nothing — otherwise the slack would jump to the
  // front of the row and shift every action left.
  //
  // jsdom computes no layout, so what is pinned here is the MECHANISM (the
  // growing cell exists in both cases, and is merely empty in one) rather than
  // the pixels it produces. The pixels follow from `flex: 1 1 0%`, which the
  // browser is entitled to be trusted on.
  it("keeps the growing cell when the title renders nothing", () => {
    const withTitle = mount(titled);
    const filled = growingCell(withTitle.container);
    expect(filled?.textContent).toBe("A title");
    cleanup();

    const without = mount(untitled);
    const empty = growingCell(without.container);
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe("");
  });

  it("titleOnly keeps the title and drops the ordinary occupants", () => {
    mount(titled, { titleOnly: true });
    expect(screen.getByText("A title")).toBeTruthy();
    expect(screen.queryByText("an-action")).toBeNull();
  });

  // The header is ONE slot. A title component rendering a slot of its own is a
  // second row the order file cannot see — the door the API cannot close, so
  // the pane closes it at runtime.
  it("throws when a render slot mounts inside title.component", () => {
    // React logs the uncaught render error before rethrowing; keep the output clean.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => mount(smuggling)).toThrow(PANE_TITLE_SLOT_ERROR);
      expect(screen.queryByText("second-row")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("lets a render slot declared partOfComponent render inside the title", () => {
    mount(withPart);
    expect(screen.getByText("own-part")).toBeTruthy();
  });

  it("lets a plain slot painted through renderIsolated render inside the title", () => {
    mount(withPlain);
    expect(screen.getByText("separator")).toBeTruthy();
  });
});
