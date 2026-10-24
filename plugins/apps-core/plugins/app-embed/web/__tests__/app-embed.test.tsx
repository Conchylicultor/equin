import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import type { ReactNode } from "react";
import {
  PluginProvider,
  PluginScope,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { useNavigate } from "@plugins/apps-core/plugins/tabs/web";
import { useRouteState } from "@plugins/primitives/plugins/pane/web";
import { ErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import { AppEmbed } from "../components/app-embed";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";

// An embed is its own surface: its route lives in its own pane store (never the
// page URL), and a hop read through the navigation boundary is the embed's — a
// same-app URL moves its route, another tab app in scope swaps the embed to
// it, anything else is `onLeave`.

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
  window.history.replaceState(null, "", "/");
});

function mount({ scoped = false }: { scoped?: boolean } = {}) {
  const onLeave = vi.fn();
  window.history.replaceState(null, "", "/host/page");
  const embed = <AppEmbed app="emb" route="/c/one" onLeave={onLeave} />;
  const inScope = (children: ReactNode) =>
    scoped ? (
      <PluginScope composition={withoutOther}>{children}</PluginScope>
    ) : (
      children
    );
  render(
    <PluginProvider plugins={[slotsPlugin, appsPlugin, otherPlugin]}>
      {inScope(embed)}
    </PluginProvider>,
  );
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

  it("a surface-mode app is onLeave", () => {
    const onLeave = mount();
    goTo("/desk");
    expect(onLeave.mock.calls).toEqual([["/desk"]]);
    expect(screen.getByTestId("app").textContent).toBe("emb");
    expect(window.location.pathname).toBe("/host/page");
  });
});
