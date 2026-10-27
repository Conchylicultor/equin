import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// The website's first-paint flash: before the surface registered its
// placements, which app owns `:root` is not known, and the injector used to
// guess the desktop — repainting the server's website theme with the desktop's
// for a frame. While the root is not known the blocks are HELD: the SAME
// `<style>` element the server painted stays, with its text, until the resolved
// text replaces it in place. A different element (a remount) would delete the
// server's CSS — `usePaintedStyle` removes its element on unmount.

const root = vi.hoisted(() => ({
  state: { known: false } as
    { known: false } | { known: true; scopeId: string | undefined },
}));

/** Every app with its own theme document, by scope id. */
const owning = vi.hoisted(() => new Set<string>());

vi.mock("@plugins/apps-core/plugins/theme-scope/web", () => ({
  useRootThemeScopeState: () => root.state,
}));

vi.mock("@plugins/apps-core/web", () => ({
  Apps: {
    App: {
      useContributions: () => [{ id: "website" }, { id: "other" }],
    },
  },
}));

vi.mock("@plugins/config_v2/web", () => ({
  useScopeMembership: (_config: unknown, scopeId: string) => ({
    status: "ready",
    data: owning.has(scopeId),
  }),
}));

vi.mock("../use-color-mode", () => ({
  useDocumentColorMode: () => undefined,
}));

const palette = vi.hoisted(() => ({ group: null as unknown }));

vi.mock("../slots", () => ({
  ThemeEngine: {
    TokenGroup: {
      useContributions: () => [
        { id: "palette", label: "Palette", descriptor: palette.group },
      ],
    },
  },
}));

// Every scope resolves at once, and reports a missing theme — so a fault
// reported while held would show up.
vi.mock("../use-resolved-theme", async () => {
  const { NEUTRAL_COLOR_ADJUSTMENT } = await import("../../core/theme");
  return {
    useResolvedTheme: (scopeId: string | undefined) => ({
      pending: false,
      themeId: "default",
      missing: `missing-for-${scopeId ?? "desktop"}`,
      theme: {
        groups: {
          palette: {
            light: { primary: scopeId ?? "desktop" },
            dark: { primary: scopeId ?? "desktop" },
          },
        },
        colorAdjust: NEUTRAL_COLOR_ADJUSTMENT,
      },
      skipped: [],
    }),
  };
});

import {
  defineTokenGroup,
  renderThemeGroupBlock,
  themeStyleId,
} from "../../core";
import { NEUTRAL_COLOR_ADJUSTMENT } from "../../core/theme";
import { themeResolutionReportSink } from "../internal/resolution-report-sink";
import { AppScopeThemes, ThemeInjector } from "../components/theme-injector";

const group = defineTokenGroup("palette", { primary: { default: "blue" } });
palette.group = group;

function painted(scopeId: string | undefined, scopeToken?: string): string {
  const v = scopeId ?? "desktop";
  return renderThemeGroupBlock(
    group,
    { light: { primary: v }, dark: { primary: v } },
    NEUTRAL_COLOR_ADJUSTMENT,
    scopeToken,
  );
}

/** A `<style>` as the server paints it into the first frame's head. */
function serverStyle(id: string, text: string): HTMLStyleElement {
  const el = document.createElement("style");
  el.id = id;
  el.textContent = text;
  document.head.appendChild(el);
  return el;
}

let emit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root.state = { known: false };
  owning.clear();
  emit = vi
    .spyOn(themeResolutionReportSink, "emit")
    .mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  document.head.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ThemeInjector while the root scope is not known", () => {
  it("keeps the server's :root element and text, then repaints it in place", () => {
    const id = themeStyleId("palette");
    const server = serverStyle(id, "SERVER-WEBSITE");

    const { rerender } = render(<ThemeInjector />);
    expect(document.getElementById(id)).toBe(server);
    expect(server.textContent).toBe("SERVER-WEBSITE");
    expect(emit).not.toHaveBeenCalled();

    root.state = { known: true, scopeId: "app:website" };
    rerender(<ThemeInjector />);
    expect(document.getElementById(id)).toBe(server);
    expect(server.textContent).toBe(painted("app:website"));
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ themeId: "missing-for-app:website" }),
    );
  });
});

describe("AppScopeThemes while the root scope is not known", () => {
  it("holds every owning app's block on the same element, then drops the root app's", () => {
    owning.add("app:website");
    owning.add("app:other");
    const otherId = themeStyleId("palette", "app:other");
    const other = serverStyle(otherId, "SERVER-OTHER");

    const { rerender } = render(<AppScopeThemes />);
    expect(document.getElementById(otherId)).toBe(other);
    expect(other.textContent).toBe("SERVER-OTHER");
    const websiteId = themeStyleId("palette", "app:website");
    expect(document.getElementById(websiteId)?.textContent).toBe("");
    expect(emit).not.toHaveBeenCalled();

    root.state = { known: true, scopeId: "app:website" };
    rerender(<AppScopeThemes />);
    expect(document.getElementById(otherId)).toBe(other);
    expect(other.textContent).toBe(painted("app:other", "app:other"));
    // The app owning `:root` needs no scoped block.
    expect(document.getElementById(websiteId)).toBeNull();
  });
});
