import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import { collectMeta } from "@plugins/primitives/plugins/ui-context/web";
import { pickerPlugin } from "./picker-plugin";

afterEach(cleanup);

const rowSlot = defineRenderSlot<{ component: ComponentType }>();
const listSlot = defineRenderSlot<{ component: ComponentType }>();

/** The progress-bar shape: a widget far smaller than the row that hosts it, so
 *  most of its own box is slack the user can point at. */
function TinyWidget() {
  return <span data-testid="widget" />;
}

function plugin(slot: typeof rowSlot): LoadedPlugin {
  return {
    id: "ui.segmented-progress-bar",
    description: "lineage fixture",
    contributions: [slot({ id: "bar", component: TinyWidget })],
    // A rendered slot must be a declared slot — its id derives from here.
    slots: { row: slot },
  } as unknown as LoadedPlugin;
}

describe("a contribution's own box resolves to the contribution", () => {
  it("attributes the layout cell — the ring of slack around a small widget", () => {
    render(
      <PluginProvider plugins={[pickerPlugin, plugin(rowSlot)]}>
        {/* Inline styles, not classes: jsdom computes these, and `.Render` only
            draws its flex cell when it MEASURES a flex-row host. */}
        <div style={{ display: "flex", flexDirection: "row" }}>
          <rowSlot.Render />
        </div>
      </PluginProvider>,
    );
    const widget = document.querySelector<HTMLElement>(
      '[data-testid="widget"]',
    )!;
    const cell = widget.closest<HTMLElement>("div.flex")!;
    expect(cell).not.toBeNull();

    // The regression: the identity used to live on a wrapper INSIDE this cell,
    // so picking the cell climbed past the whole contribution and reported
    // whatever region enclosed the slot's host.
    const meta = collectMeta(cell);
    expect(meta.pluginId).toBe("ui.segmented-progress-bar");
    expect(meta.slotId).toBe("ui.segmented-progress-bar.row");
    expect(meta.contributionId).toBe("ui.segmented-progress-bar:bar");

    // A real box the user can point at, so it is NOT marked boxless — its own
    // source and selector segment are the honest answer for a pick on it.
    expect(cell.dataset.lineageBoxless).toBeUndefined();
    expect(collectMeta(widget).pluginId).toBe("ui.segmented-progress-bar");
  });

  it("marks the box boxless when the slot draws no layout cell", () => {
    render(
      <PluginProvider plugins={[pickerPlugin, plugin(listSlot)]}>
        <div>
          <listSlot.Render />
        </div>
      </PluginProvider>,
    );
    const widget = document.querySelector<HTMLElement>(
      '[data-testid="widget"]',
    )!;
    const box = widget.closest<HTMLElement>('[data-lineage="contribution"]')!;
    expect(box.dataset.lineageBoxless).toBe("");
    expect(collectMeta(widget).pluginId).toBe("ui.segmented-progress-bar");
  });
});

describe("a container's inner slots", () => {
  it("names the slots laid out inside a pick that lies in none of them", () => {
    render(
      <PluginProvider
        plugins={[
          pickerPlugin,
          {
            id: "conversations.conversation-view",
            description: "lineage fixture",
            contributions: [
              rowSlot({ id: "input", component: TinyWidget }),
              listSlot({ id: "pill", component: TinyWidget }),
              listSlot({ id: "pill-2", component: TinyWidget }),
            ],
            slots: { "prompt-input": rowSlot, "prompt-bar": listSlot },
          } as unknown as LoadedPlugin,
        ]}
      >
        <div data-testid="bottom-bar">
          <rowSlot.Render />
          <listSlot.Render />
        </div>
      </PluginProvider>,
    );
    const bar = document.querySelector('[data-testid="bottom-bar"]')!;
    const meta = collectMeta(bar);
    expect(meta.slotId).toBeUndefined();
    // Distinct, in document order.
    expect(meta.innerSlots).toBe(
      "conversations.conversation-view.prompt-input, conversations.conversation-view.prompt-bar",
    );
    // A leaf holds no slots, so the field is omitted rather than empty.
    const widget = document.querySelector('[data-testid="widget"]')!;
    expect(collectMeta(widget).innerSlots).toBeUndefined();
  });
});
