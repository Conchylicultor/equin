import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// `:root` wears the desktop's theme whatever app is focused and whatever the
// surface mode: re-rooting it restyled the whole document on every switch
// between the desktop and full screen. Each themed app's block is painted on
// its own scope, focused or not, so a focus change rewrites no token block —
// only the document canvas (`<body>`'s background) follows the focused app.

const root = vi.hoisted(() => ({
  state: { known: false } as
    { known: false } | { known: true; scopeId: string | undefined },
}));

/** Every app with its own theme document, by scope id. */
const owning = vi.hoisted(() => new Set<string>());

vi.mock(
  "@plugins/apps-core/plugins/theme-scope/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useRootThemeScopeState: () => root.state,
  }),
);

vi.mock("@plugins/apps-core/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Apps: {
    App: {
      useContributions: () => [{ id: "website" }, { id: "other" }],
    },
  },
}));

vi.mock("@plugins/config_v2/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useScopeMembership: (_config: unknown, scopeId: string) => ({
    status: "ready",
    data: owning.has(scopeId),
  }),
}));

// The website is light, the desktop dark: the canvas takes the focused app's.
vi.mock("../use-color-mode", () => ({
  appIdOf: (scopeId: string | undefined) => scopeId?.slice("app:".length),
  useColorModeSettingFor: (appId: string | undefined) => ({
    effective: appId === "website" ? "light" : "dark",
  }),
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

// Every scope resolves at once, and reports a missing theme.
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
            light: {
              primary: scopeId ?? "desktop",
              background: `bg-${scopeId ?? "desktop"}`,
            },
            dark: {
              primary: scopeId ?? "desktop",
              background: `bg-${scopeId ?? "desktop"}`,
            },
          },
        },
        colorAdjust: NEUTRAL_COLOR_ADJUSTMENT,
      },
      skipped: [],
    }),
  };
});

import {
  CANVAS_STYLE_ID,
  defineTokenGroup,
  renderThemeGroupBlock,
  themeStyleId,
} from "../../core";
import { NEUTRAL_COLOR_ADJUSTMENT } from "../../core/theme";
import { themeResolutionReportSink } from "../internal/resolution-report-sink";
import { AppScopeThemes, ThemeInjector } from "../components/theme-injector";

const group = defineTokenGroup("palette", {
  primary: { default: "blue" },
  background: { default: "white" },
});
palette.group = group;

function painted(scopeId: string | undefined, scopeToken?: string): string {
  const v = scopeId ?? "desktop";
  return renderThemeGroupBlock(
    group,
    {
      light: { primary: v, background: `bg-${v}` },
      dark: { primary: v, background: `bg-${v}` },
    },
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

describe("ThemeInjector", () => {
  it("paints the desktop's theme on :root, adopting the server's element, whatever app is focused", () => {
    const id = themeStyleId("palette");
    const server = serverStyle(id, painted(undefined));

    const { rerender } = render(<ThemeInjector />);
    expect(document.getElementById(id)).toBe(server);
    expect(server.textContent).toBe(painted(undefined));

    root.state = { known: true, scopeId: "app:website" };
    rerender(<ThemeInjector />);
    expect(document.getElementById(id)).toBe(server);
    expect(server.textContent).toBe(painted(undefined));

    root.state = { known: true, scopeId: undefined };
    rerender(<ThemeInjector />);
    expect(server.textContent).toBe(painted(undefined));
  });

  it("holds the server's canvas until the root is known, then follows the focused app", () => {
    const canvas = serverStyle(CANVAS_STYLE_ID, "SERVER-CANVAS");

    const { rerender } = render(<ThemeInjector />);
    expect(document.getElementById(CANVAS_STYLE_ID)).toBe(canvas);
    expect(canvas.textContent).toBe("SERVER-CANVAS");

    root.state = { known: true, scopeId: "app:website" };
    rerender(<ThemeInjector />);
    expect(canvas.textContent).toBe(
      "body {\n  background-color: bg-app:website;\n}",
    );

    root.state = { known: true, scopeId: undefined };
    rerender(<ThemeInjector />);
    expect(canvas.textContent).toContain("bg-desktop");
  });
});

describe("AppScopeThemes", () => {
  it("paints every owning app's block, the focused one included, and keeps it across focus changes", () => {
    owning.add("app:website");
    const otherId = themeStyleId("palette", "app:other");
    const websiteId = themeStyleId("palette", "app:website");

    const { rerender } = render(<AppScopeThemes />);
    const website = document.getElementById(websiteId);
    expect(website?.textContent).toBe(painted("app:website", "app:website"));
    // An app without its own theme document inherits `:root` whole.
    expect(document.getElementById(otherId)).toBeNull();

    root.state = { known: true, scopeId: "app:website" };
    rerender(<AppScopeThemes />);
    expect(document.getElementById(websiteId)).toBe(website);
    expect(website?.textContent).toBe(painted("app:website", "app:website"));
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ themeId: "missing-for-app:website" }),
    );
  });
});
