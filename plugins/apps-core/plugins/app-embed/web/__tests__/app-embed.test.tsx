import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { useNavigate } from "@plugins/apps-core/plugins/tabs/web";
import { useRouteState } from "@plugins/primitives/plugins/pane/web";
import { ErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import { AppEmbed } from "../components/app-embed";

// An embed is its own surface: its route lives in its own pane store (never the
// page URL), and a hop read through the navigation boundary is the embed's — a
// same-app URL moves its route, another app is `onLeave`.

/** Where the probe's button navigates — set by the test before clicking. */
const target = { url: "" };

function Probe() {
  const state = useRouteState();
  const go = useNavigate();
  return (
    <>
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
      app: { id: "emb", name: "Embedded", basePath: "/emb", iconKey: "home" },
      component: Probe,
      icon: {} as never,
    }),
  ],
} as unknown as LoadedPlugin;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

function mount() {
  const onLeave = vi.fn();
  window.history.replaceState(null, "", "/host/page");
  render(
    <PluginProvider plugins={[slotsPlugin, appsPlugin]}>
      <AppEmbed app="emb" route="/c/one" onLeave={onLeave} />
    </PluginProvider>,
  );
  return onLeave;
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
});
