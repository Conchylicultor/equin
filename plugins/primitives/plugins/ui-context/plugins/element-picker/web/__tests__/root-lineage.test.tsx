import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  Core,
  defineRootSlot,
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { RenderCoreRoot } from "@plugins/primitives/plugins/slot-render/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import {
  collectMeta,
  LINEAGE_ATTR,
} from "@plugins/primitives/plugins/ui-context/web";
import { pickerPlugin } from "./picker-plugin";

afterEach(cleanup);

// Root mounts (the Ask card, the floating action bar, toasts, dialogs) used to
// bypass slot-render, so a pick inside one — or inside a popover opened from
// one — named no plugin at all. They render through slot-render now.

/** A root mount that portals a popover out, like the action bar's health dot. */
function FloatingHost() {
  return (
    <div data-testid="host">
      <ViewportOverlay>
        <button data-testid="popover">Pick me</button>
      </ViewportOverlay>
    </div>
  );
}

const capabilityRoot = defineRootSlot();

function CompanionMount() {
  return <span data-testid="companion" />;
}

const hostPlugin = {
  id: "shell.global-action-bar",
  description: "root mount fixture",
  contributions: [Core.Root({ component: FloatingHost })],
} as unknown as LoadedPlugin;

const capabilityPlugin = {
  id: "ui.icons",
  description: "root-slot owner fixture",
  contributions: [Core.Root({ slot: capabilityRoot })],
  slots: { root: capabilityRoot },
} as unknown as LoadedPlugin;

const companionPlugin = {
  id: "ui.icons.sprites",
  description: "root-slot companion fixture",
  contributions: [capabilityRoot({ component: CompanionMount })],
} as unknown as LoadedPlugin;

function renderRoot() {
  render(
    <PluginProvider
      plugins={[pickerPlugin, hostPlugin, capabilityPlugin, companionPlugin]}
    >
      <RenderCoreRoot />
    </PluginProvider>,
  );
}

const byTestId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

describe("Core.Root mounts carry their lineage", () => {
  it("stamps a root mount's box, as a layout-neutral contribution marker", () => {
    renderRoot();
    const box = byTestId("host").closest<HTMLElement>(
      '[data-lineage="contribution"]',
    )!;
    expect(box).not.toBeNull();
    // No layout cell: the box is display:contents, so the mount keeps the
    // layout role it had as a bare child of the root.
    expect(box.className).toBe("contents");
    expect(box.dataset.lineageBoxless).toBe("");
    const meta = collectMeta(byTestId("host"));
    expect(meta.pluginId).toBe("shell.global-action-bar");
    expect(meta.slotId).toBe(Core.Root.id);
    expect(Core.Root.id).toBe("framework.web-sdk.root");
  });

  it("forwards the lineage across a popover the root mount portals out", () => {
    renderRoot();
    const popover = byTestId("popover");
    // Portaled to document.body: no DOM ancestor marker, only the forwarded one.
    expect(popover.closest('[data-lineage="contribution"]')).toBeNull();
    expect(popover.closest(`[${LINEAGE_ATTR}]`)).not.toBeNull();
    const meta = collectMeta(popover);
    expect(meta.pluginId).toBe("shell.global-action-bar");
    expect(meta.path).toBe("shell.global-action-bar@framework.web-sdk.root");
  });

  it("attributes a root slot's mount to that slot and its companion", () => {
    renderRoot();
    const meta = collectMeta(byTestId("companion"));
    expect(meta.pluginId).toBe("ui.icons.sprites");
    expect(meta.slotId).toBe("ui.icons.root");
  });
});
