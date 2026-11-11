import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { StrictMode, type ReactNode } from "react";
import {
  PluginProvider,
  PluginScope,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import {
  peekFocusedTabSet,
  useNavigate,
  useTabs,
} from "@plugins/apps-core/plugins/tabs/web";
import {
  Pane,
  PaneInstanceContext,
  PaneSurfaceProvider,
  setLiveStore,
  useIndexMatch,
  usePaneViews,
  useRouteState,
} from "@plugins/primitives/plugins/pane/web";
import {
  createTestSurfaceStore,
  defaultStore,
} from "@plugins/primitives/plugins/pane/web/testing";
import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";
import { ErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import {
  getFocusedSurfaceId,
  setFocusedSurfaceId,
} from "@plugins/primitives/plugins/shortcuts/web";
import {
  AppEmbed,
  useEmbedPlace,
  type EmbedPlace,
} from "../components/app-embed";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";

// An embed is its own tab set: its routes live in its own pane stores (never
// the page URL), and a hop read through the navigation boundary is the
// embed's — a same-app URL moves its route, another tab app in scope swaps the
// embed's tab to it, a surface-mode app's base path switches the embed's mode,
// anything else is `onLeave`.

/** An overlay that says which tab set it is drawn in. */
function OverlayProbe() {
  const { id, contained } = useTabs();
  return <div data-testid="overlay">{`${id} contained=${contained}`}</div>;
}

/** Where the probe's button navigates — set by the test before clicking. */
const target = { url: "" };

function Probe({ app }: { app: string }) {
  const state = useRouteState();
  const go = useNavigate();
  return (
    <>
      <div data-testid="app">{app}</div>
      <div data-testid="route">
        {state.kind === "unresolved" ? `pending:${state.rawPath}` : "resolved"}
      </div>
      <button type="button" onClick={() => go(target.url)}>
        go
      </button>
    </>
  );
}

// The slots the surface reads, declared as their owners declare them.
const slotsPlugin = {
  id: "app-embed-test-slots",
  description: "the apps-core and error-boundary slots",
  slots: { ...Apps, ...ErrorBoundary },
  contributions: [],
} as unknown as LoadedPlugin;

const appsPlugin = {
  id: "app-embed-test-apps",
  description: "fake apps for the app-embed suite",
  contributions: [
    Apps.App({
      app: {
        id: "emb",
        name: "Embedded",
        basePath: "/emb",
        icon: symbol("home"),
      },
      component: () => <Probe app="emb" />,
    }),
    Apps.Overlay({ id: "probe-overlay", component: OverlayProbe }),
    // A surface-mode app: it owns no URL, so the embed cannot hold it.
    Apps.App({
      app: {
        id: "desk",
        name: "Desk",
        basePath: "/desk",
        icon: symbol("home"),
      },
      surfaceMode: "desktop",
    }),
  ],
} as unknown as LoadedPlugin;

const otherPlugin = {
  id: "app-embed-test-other",
  description: "a second tab app for the app-embed suite",
  contributions: [
    Apps.App({
      app: {
        id: "other",
        name: "Other",
        basePath: "/other",
        icon: symbol("home"),
      },
      component: () => <Probe app="other" />,
    }),
  ],
} as unknown as LoadedPlugin;

/** A composition serving every test plugin but `other`. */
const withoutOther = {
  id: "app-embed-test-scope",
  home: "emb",
  plugins: [slotsPlugin.id, appsPlugin.id],
};

afterEach(() => {
  cleanup();
  setFocusedSurfaceId(undefined);
  window.history.replaceState(null, "", "/");
});

function mount({
  scoped = false,
  fillsPage = false,
  strict = false,
}: { scoped?: boolean; fillsPage?: boolean; strict?: boolean } = {}) {
  const onLeave = vi.fn();
  window.history.replaceState(null, "", "/host/page");
  const embed = (
    <AppEmbed
      app="emb"
      route="/c/one"
      onLeave={onLeave}
      fills={fillsPage ? "page" : undefined}
    />
  );
  const inScope = (children: ReactNode) =>
    scoped ? (
      <PluginScope composition={withoutOther}>{children}</PluginScope>
    ) : (
      children
    );
  const tree = (
    <PluginProvider
      plugins={[slotsPlugin, appsPlugin, otherPlugin]}
      composition={{ id: "app-embed-test", home: "emb" }}
    >
      {inScope(embed)}
    </PluginProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return onLeave;
}

/** The theme scope the embed's surface wears. */
function themeScope(): string | null {
  return (
    screen
      .getByTestId("app")
      .closest("[data-theme-scope]")
      ?.getAttribute("data-theme-scope") ?? null
  );
}

function goTo(url: string) {
  target.url = url;
  act(() => screen.getByRole("button", { name: "go" }).click());
}

describe("<AppEmbed>", () => {
  it("renders the app at its seeded route, leaving the page URL alone", () => {
    mount();
    expect(screen.getByTestId("route").textContent).toBe("pending:c/one");
    expect(window.location.pathname).toBe("/host/page");
  });

  it("a same-app URL moves the embed's own route, not the page's", () => {
    const onLeave = mount();
    goTo("/emb/c/two");
    expect(screen.getByTestId("route").textContent).toBe("pending:c/two");
    expect(window.location.pathname).toBe("/host/page");
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("another app's URL is onLeave, and the embed stays", () => {
    const onLeave = mount();
    goTo("/elsewhere/x");
    expect(onLeave.mock.calls).toEqual([["/elsewhere/x"]]);
    expect(screen.getByTestId("route").textContent).toBe("pending:c/one");
  });

  it("another tab app in scope swaps the embed to it, and back", () => {
    const onLeave = mount();
    expect(themeScope()).toBe(appThemeScope("emb"));

    goTo("/other/c/x");
    expect(screen.getByTestId("app").textContent).toBe("other");
    expect(screen.getByTestId("route").textContent).toBe("pending:c/x");
    expect(themeScope()).toBe(appThemeScope("other"));
    expect(window.location.pathname).toBe("/host/page");

    goTo("/emb/c/y");
    expect(screen.getByTestId("app").textContent).toBe("emb");
    expect(screen.getByTestId("route").textContent).toBe("pending:c/y");
    expect(themeScope()).toBe(appThemeScope("emb"));
    expect(window.location.pathname).toBe("/host/page");
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("an app's bare base path opens it at its index", () => {
    mount();
    goTo("/other");
    expect(screen.getByTestId("app").textContent).toBe("other");
    expect(screen.getByTestId("route").textContent).toBe("resolved");
  });

  it("an app outside the scope is onLeave", () => {
    const onLeave = mount({ scoped: true });
    goTo("/other/c/x");
    expect(onLeave.mock.calls).toEqual([["/other/c/x"]]);
    expect(screen.getByTestId("app").textContent).toBe("emb");
    expect(screen.getByTestId("route").textContent).toBe("pending:c/one");
  });

  it("draws the apps overlays inside, over its own tab set", () => {
    mount();
    expect(screen.getByTestId("overlay").textContent).toMatch(
      /^embed:.* contained=true$/,
    );
  });

  it("a surface-mode app switches the embed's own mode, never leaves", () => {
    const onLeave = mount();
    goTo("/desk");
    expect(onLeave).not.toHaveBeenCalled();
    expect(screen.getByTestId("app").textContent).toBe("emb");
    expect(window.location.pathname).toBe("/host/page");
  });

  it("an embed inside a page leaves the keyboard where it was at mount", () => {
    setFocusedSurfaceId("host-tab");
    mount();
    expect(getFocusedSurfaceId()).toBe("host-tab");
  });

  it("an embed that fills the page takes the keyboard at mount", () => {
    setFocusedSurfaceId("host-tab");
    mount({ fillsPage: true });
    const focused = getFocusedSurfaceId();
    expect(focused).not.toBe("host-tab");
    expect(focused).toBeDefined();
  });

  it("keeps the keyboard through StrictMode's remount", () => {
    setFocusedSurfaceId("host-tab");
    mount({ fillsPage: true, strict: true });
    const focused = getFocusedSurfaceId();
    expect(focused).not.toBe("host-tab");
    expect(focused).toBeDefined();
  });

  describe("its place, in the page's URL", () => {
    // The host page: an app at `/host` whose landing pane holds the embed.
    const hostApp = defineApp({
      id: "host",
      name: "Host",
      basePath: "/host",
      icon: symbol("home"),
    });
    type PaneViews = NonNullable<ReturnType<typeof usePaneViews>>;
    let place: EmbedPlace | null = null;
    let views: PaneViews | null = null;
    /** Hands the host's handles to the test (the view-param suite's pattern). */
    function capture(p: EmbedPlace, v: PaneViews | null) {
      place = p;
      views = v;
    }
    function PlaceProbe() {
      capture(useEmbedPlace(), usePaneViews());
      return null;
    }
    const hostPane = Pane.define({
      route: defineRoute({ id: "app-embed-test-host", segment: "" }),
      app: hostApp,
      appIndex: true,
      component: () => (
        <>
          <PlaceProbe />
          <AppEmbed fills="page" />
        </>
      ),
    });
    const hostPlugin = {
      id: "app-embed-test-host",
      description: "the page hosting the embed",
      contributions: [Pane.Register({ pane: hostPane })],
    } as unknown as LoadedPlugin;

    /** The landing pane's one instance, rendered as a layout renders it. */
    function HostLayout() {
      const match = useIndexMatch("/host");
      const entry = match?.panes[0];
      if (!entry) return null;
      const Body = entry.pane.component;
      return (
        <PaneInstanceContext.Provider value={entry.instanceId}>
          <Body />
        </PaneInstanceContext.Provider>
      );
    }

    function mountHost(path: string) {
      window.history.replaceState(null, "", path);
      const store = createTestSurfaceStore();
      render(
        <PluginProvider
          plugins={[slotsPlugin, appsPlugin, otherPlugin, hostPlugin]}
          composition={{ id: "app-embed-test", home: "emb" }}
        >
          <PaneSurfaceProvider store={store} basePath="/host">
            <HostLayout />
          </PaneSurfaceProvider>
        </PluginProvider>,
      );
      return store;
    }

    afterEach(() => {
      place = null;
      views = null;
      setLiveStore(defaultStore);
    });

    it("opens on the composition's home app, and writes no place no one chose", () => {
      mountHost("/host");
      expect(screen.getByTestId("app").textContent).toBe("emb");
      expect(window.location.pathname).toBe("/host");
      // The user's first move is the first place written.
      goTo("/other/c/x");
      expect(window.location.pathname).toBe("/host/at/other/c/x");
    });

    it("a maximize before any move is the flag alone", () => {
      mountHost("/host");
      act(() => place!.setMaximized(true));
      expect(window.location.pathname).toBe("/host;full=1");
      goTo("/other/c/x");
      expect(window.location.pathname).toBe("/host/at/other/c/x;full=1");
    });

    it("hands its title to the host as it moves, and takes it back when it unmounts", () => {
      const onTitleChange = vi.fn();
      render(
        <PluginProvider
          plugins={[slotsPlugin, appsPlugin, otherPlugin]}
          composition={{ id: "app-embed-test", home: "emb" }}
        >
          <AppEmbed fills="page" onTitleChange={onTitleChange} />
        </PluginProvider>,
      );
      expect(onTitleChange.mock.calls.at(-1)).toEqual(["Embedded"]);
      goTo("/other/c/x");
      expect(onTitleChange.mock.calls.at(-1)).toEqual(["Other"]);
      cleanup();
      expect(onTitleChange.mock.calls.at(-1)).toEqual([undefined]);
    });

    it("opens where the page's URL says", () => {
      mountHost("/host/at/other/c/x");
      expect(screen.getByTestId("app").textContent).toBe("other");
      expect(screen.getByTestId("route").textContent).toBe("pending:c/x");
    });

    it("framed, a move rewrites the current entry", () => {
      mountHost("/host/at/emb/c/one");
      const length = window.history.length;
      goTo("/other/c/x");
      expect(window.location.pathname).toBe("/host/at/other/c/x");
      expect(window.history.length).toBe(length);
    });

    it("maximized, a move is the entry the app's own tab would write", () => {
      mountHost("/host/at/emb/c/one;full=1");
      expect(place!.maximized).toBe(true);
      const length = window.history.length;
      goTo("/other/c/x");
      expect(window.location.pathname).toBe("/host/at/other/c/x;full=1");
      expect(window.history.length).toBe(length + 1);
    });

    it("Maximize and Restore are the page's own steps (pushed)", () => {
      mountHost("/host/at/emb/c/one");
      const length = window.history.length;
      act(() => place!.setMaximized(true));
      expect(window.location.pathname).toBe("/host/at/emb/c/one;full=1");
      expect(window.history.length).toBe(length + 1);
      act(() => place!.setMaximized(false));
      expect(window.location.pathname).toBe("/host/at/emb/c/one");
    });

    it("is a reveal boundary: a reveal inside never scrolls its host page", () => {
      mountHost("/host");
      expect(
        screen.getByTestId("app").closest("[data-reveal-boundary]"),
      ).not.toBeNull();
    });

    it("follows the page's URL when it changes under it (Back / Forward)", () => {
      mountHost("/host/at/emb/c/one");
      goTo("/other/c/x");
      expect(screen.getByTestId("app").textContent).toBe("other");
      act(() => views!.set({ embed: "/emb/c/one" }));
      expect(screen.getByTestId("app").textContent).toBe("emb");
      expect(screen.getByTestId("route").textContent).toBe("pending:c/one");
    });

    it("addresses a new browser tab as this page there, maximized", () => {
      mountHost("/host/at/emb/c/one");
      expect(peekFocusedTabSet()?.browserTabUrl("/other/c/x")).toBe(
        "/host/at/other/c/x;full=1",
      );
    });

    it("outside any pane, keeps its place to itself", () => {
      mount({ fillsPage: true });
      goTo("/other/c/x");
      expect(window.location.pathname).toBe("/host/page");
      expect(peekFocusedTabSet()?.browserTabUrl("/other/c/x")).toBe(
        "/other/c/x",
      );
    });
  });
});
