import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type {
  CreateOption,
  DataViewDensity,
  ToolbarArrangement,
  ToolbarParts,
} from "../../core";
import { DataViewToolbar } from "../components/toolbar/data-view-toolbar";
import {
  DataViewControlsProvider,
  type DataViewControlsContextValue,
} from "../components/controls/controls-context";

/**
 * The arrangement seam: no `toolbar` renders the default inline bar; an
 * arrangement receives the parts built in the forms it asked for; and the
 * compact fold stays the host's, whatever arrangement was passed.
 */

const plugin = {
  id: "data-view-toolbar-arrangement-test",
  description: "toolbar arrangement fixture",
  contributions: [],
} as unknown as LoadedPlugin;

const CREATORS: CreateOption[] = [
  { id: "new", label: "New thing", onSelect: () => {} },
];

let lastParts: ToolbarParts | null = null;

const recordingArrangement: ToolbarArrangement = {
  id: "recording",
  forms: { search: "bare", controls: "round", creators: "round" },
  component: (parts) => {
    lastParts = parts;
    return (
      <div data-testid="arrangement">
        {parts.switcher.chip}
        {parts.search}
        {parts.creators}
      </div>
    );
  },
};

function renderToolbar(opts: {
  arrangement?: ToolbarArrangement;
  density?: DataViewDensity;
  searchPlaceholder?: string;
  asideInset?: string;
  creators?: CreateOption[];
}) {
  lastParts = null;
  return render(
    <PluginProvider plugins={[plugin]}>
      <DataViewControlsProvider {...({} as DataViewControlsContextValue)}>
        <DataViewToolbar
          query=""
          onQueryChange={() => {}}
          creators={"creators" in opts ? opts.creators : CREATORS}
          switcher={{
            strip: <div data-testid="strip" />,
            chip: <div data-testid="chip" />,
          }}
          switcherCount={2}
          density={opts.density}
          arrangement={opts.arrangement}
          searchPlaceholder={opts.searchPlaceholder}
          asideInset={opts.asideInset}
        />
      </DataViewControlsProvider>
    </PluginProvider>,
  );
}

afterEach(cleanup);

describe("DataViewToolbar arrangements", () => {
  it("renders the default bar when no arrangement is passed", () => {
    renderToolbar({});

    expect(screen.getByTestId("strip")).toBeTruthy();
    expect(screen.queryByTestId("chip")).toBeNull();
    // The search as a quiet well in its fixed lane, and a labelled creator.
    const input = screen.getByPlaceholderText("Search…");
    expect(input.parentElement!.className).toContain("w-48");
    const create = screen.getByRole("button", { name: "New thing" });
    expect(create.textContent).toBe("New thing");
    // Two floating pills: the views (the strip) and the tools (search, then a
    // divider before create).
    const views = screen.getByRole("group", { name: "Views" });
    const tools = screen.getByRole("group", { name: "Tools" });
    expect(views.className).toContain("bg-float-fill");
    expect(tools.className).toContain("bg-float-fill");
    expect(views.contains(screen.getByTestId("strip"))).toBe(true);
    expect(tools.contains(input)).toBe(true);
    expect(tools.contains(create)).toBe(true);
    expect(tools.querySelector('[data-slot="separator"]')).not.toBeNull();
  });

  it("drops the divider when the surface declares no creators", () => {
    renderToolbar({ creators: undefined });

    const tools = screen.getByRole("group", { name: "Tools" });
    expect(tools.querySelector('[data-slot="separator"]')).toBeNull();
  });

  it("hangs the fade under an opaque band, then the default bar's runway", () => {
    const { container } = renderToolbar({});

    const band = container.firstElementChild as HTMLElement;
    // The band itself is opaque and draws no tail of its own…
    expect(band.className).toContain("bg-chrome-mask");
    expect(band.className).not.toContain("sticky-fade");
    // …the tail is the next sibling, pinned at the band's measured bottom,
    // below the band's layer (so pinned group headers cover it)…
    const tail = band.nextElementSibling as HTMLElement;
    expect(tail.className).toContain("sticky-fade");
    expect(tail.className).toContain("z-raised");
    expect(tail.style.top).toBe("var(--dv-header-offset, 0px)");
    // …and the runway that keeps an unscrolled first row out of it.
    const runway = tail.nextElementSibling as HTMLElement;
    expect(runway.style.height).toContain("--sticky-fade-tail");
  });

  it("hands an arrangement the parts, built in the forms it asked for", () => {
    renderToolbar({
      arrangement: recordingArrangement,
      searchPlaceholder: "Search apps",
    });

    expect(screen.getByTestId("arrangement")).toBeTruthy();
    expect(screen.getByTestId("chip")).toBeTruthy();
    expect(screen.queryByTestId("strip")).toBeNull();
    // Bare search: the `/` hint, and the surface's own placeholder.
    expect(screen.getByText("/")).toBeTruthy();
    const input = screen.getByPlaceholderText("Search apps");
    // Round creator: the label moves off the button face.
    expect(screen.getByRole("button", { name: "New thing" }).textContent).toBe(
      "",
    );

    act(() => lastParts!.focusSearch());
    expect(document.activeElement).toBe(input);
  });

  it("puts an arrangement's spaceBelow after the sticky band, never inside it", () => {
    const { container } = renderToolbar({
      arrangement: { ...recordingArrangement, spaceBelow: "50px" },
    });

    const spacer = container.querySelector<HTMLElement>(
      '[aria-hidden="true"][style*="height: 50px"]',
    );
    expect(spacer).not.toBeNull();
    // A later sibling of the band that holds the arrangement — so the pinned
    // band (and its measured header offset) never grows by it.
    const band = container.firstElementChild!;
    expect(band.contains(screen.getByTestId("arrangement"))).toBe(true);
    expect(band.contains(spacer)).toBe(false);
    expect(spacer!.parentElement).toBe(band.parentElement);
  });

  it("drops spaceBelow and the fade in the compact fold", () => {
    const { container } = renderToolbar({
      arrangement: { ...recordingArrangement, spaceBelow: "50px" },
      density: "compact",
    });

    expect(container.querySelector('[style*="height: 50px"]')).toBeNull();
    expect(container.querySelector(".sticky-fade")).toBeNull();
  });

  it("folds to the compact bar under density=compact, whatever the arrangement", () => {
    renderToolbar({ arrangement: recordingArrangement, density: "compact" });

    expect(screen.queryByTestId("arrangement")).toBeNull();
    expect(lastParts).toBeNull();
    // The compact bar shows the strip (more than one view) and folds search away.
    expect(screen.getByTestId("strip")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Search…")).toBeNull();
    // Still two pills: the views, and the tools holding create + options.
    const views = screen.getByRole("group", { name: "Views" });
    const tools = screen.getByRole("group", { name: "Tools" });
    expect(views.contains(screen.getByTestId("strip"))).toBe(true);
    expect(
      tools.contains(screen.getByRole("button", { name: "New thing" })),
    ).toBe(true);
    const options = screen.getByRole("button", { name: "View options" });
    expect(tools.contains(options)).toBe(true);
    // The trigger reveals on hover; the pill (holding create) stays.
    expect(options.className).toContain("opacity-0");
    expect(tools.className).not.toContain("opacity-0");
  });

  it("reveals the compact tools pill itself when it holds only the trigger", () => {
    renderToolbar({ density: "compact", creators: undefined });

    const tools = screen.getByRole("group", { name: "Tools" });
    const options = screen.getByRole("button", { name: "View options" });
    expect(tools.contains(options)).toBe(true);
    // No empty pill at rest: the reveal moves from the trigger onto the pill.
    expect(tools.className).toContain("opacity-0");
    expect(options.className).not.toContain("opacity-0");
  });

  it("floats an overlay arrangement's band: absolute, click-through, past the aside", () => {
    renderToolbar({
      arrangement: {
        ...recordingArrangement,
        overlay: true,
        spaceBelow: "50px",
      },
      asideInset: "240px",
    });

    const band = screen.getByTestId("arrangement").parentElement!;
    expect(band.className).toContain("absolute");
    expect(band.className).toContain("pointer-events-none");
    expect(lastParts!.asideInset).toBe("240px");
    // An overlay band takes no room, so it owes the view no space below.
    expect(document.querySelector('[style*="height: 50px"]')).toBeNull();
  });

  it("hands an in-flow arrangement a zero aside inset by default", () => {
    renderToolbar({ arrangement: recordingArrangement });

    expect(lastParts!.asideInset).toBe("0px");
    const band = screen.getByTestId("arrangement").parentElement!;
    expect(band.className).not.toContain("pointer-events-none");
  });

  it("floats the compact fold as one card under an overlay arrangement", () => {
    renderToolbar({
      arrangement: { ...recordingArrangement, overlay: true },
      density: "compact",
    });

    expect(screen.queryByTestId("arrangement")).toBeNull();
    const strip = screen.getByTestId("strip");
    // The card opts back into pointer events over the click-through band.
    expect(strip.closest(".pointer-events-auto")).not.toBeNull();
    expect(strip.closest(".pointer-events-none")).not.toBeNull();
  });
});
