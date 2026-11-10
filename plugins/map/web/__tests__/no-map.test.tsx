import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { GeoMap } from "../slots";
import { MapView } from "../components/map-view";
import type { MapRendererReadiness } from "../slots";

afterEach(cleanup);

// `onNoMap`: a map host that cannot draw a map (no renderer installed, or the
// renderer blocked — no key) says so, so a caller listing "what the map shows"
// renders every row instead of waiting on a camera that will never rest.

function renderer(readiness: MapRendererReadiness): LoadedPlugin {
  return {
    id: "test-renderer",
    description: "a renderer in a fixed state",
    contributions: [
      GeoMap.Renderer({
        id: "test",
        label: "Test map",
        tiles: "light",
        component: () => <span>drawn</span>,
        useReadiness: () => readiness,
        AccessAction: () => <span>no key</span>,
      }),
    ],
  } as unknown as LoadedPlugin;
}

const owner = {
  id: "map",
  description: "the map slots",
  slots: GeoMap,
  contributions: [],
} as unknown as LoadedPlugin;

function mount(plugins: LoadedPlugin[]) {
  const onNoMap = vi.fn();
  render(
    <PluginProvider plugins={[owner, ...plugins]}>
      <MapView overlays={[]} empty={null} onNoMap={onNoMap} />
    </PluginProvider>,
  );
  return onNoMap;
}

describe("MapView onNoMap", () => {
  it("is told when no renderer is installed", () => {
    const onNoMap = mount([]);
    expect(screen.getByText(/No map renderer is installed/)).toBeTruthy();
    expect(onNoMap).toHaveBeenCalledTimes(1);
  });

  it("is told when the renderer is blocked", () => {
    const onNoMap = mount([renderer("blocked")]);
    expect(screen.getByText("no key")).toBeTruthy();
    expect(onNoMap).toHaveBeenCalledTimes(1);
  });

  it("is not told while the renderer is pending or ready", () => {
    expect(mount([renderer("pending")])).not.toHaveBeenCalled();
    cleanup();
    const onNoMap = mount([renderer("ready")]);
    expect(screen.getByText("drawn")).toBeTruthy();
    expect(onNoMap).not.toHaveBeenCalled();
  });
});
