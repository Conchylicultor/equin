/**
 * Hibernation inside a real `<DemoScope>`: `useMarkConversationViewed()` is
 * bound through `useFetchEndpoint()`, so it reaches the scope's server, where
 * the plugin's own `Demo.Route` answers `not-hibernated` — nothing reaches the
 * page's server.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect, type ReactElement } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { Demo } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { DemoScope } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web/testing";
import { implement } from "@plugins/infra/plugins/endpoints/core";
import { markViewed } from "../../shared/endpoints";
import { useMarkConversationViewed } from "../internal/mark-viewed";

afterEach(cleanup);

/**
 * Render inside an awaited `act`, so the scope's server effect has run.
 */
async function renderAsync(ui: ReactElement) {
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(ui);
  });
  return view!;
}

describe("hibernation in a demo scope", () => {
  it("useMarkConversationViewed resolves not-hibernated through the contributed route", async () => {
    const plugins = [
      {
        id: "framework.browser-server.demo" as PluginId,
        description: "scope fixture",
        slots: Demo,
        contributions: [],
      },
      {
        id: "conversations.hibernation" as PluginId,
        description: "hibernation fixture",
        // The plugin's own contribution (web/index.ts), restated: a test may
        // not import its own barrel's default export.
        contributions: [
          Demo.Route({
            route: [
              markViewed.route,
              implement(markViewed, () => ({
                kind: "not-hibernated" as const,
              })),
            ],
          }),
        ],
      },
    ] as unknown as LoadedPlugin[];
    let mark: ((id: string) => Promise<unknown>) | null = null;
    function Probe() {
      const fn = useMarkConversationViewed();
      useEffect(() => {
        mark = fn;
      }, [fn]);
      return null;
    }
    await renderAsync(
      <PluginProvider plugins={plugins}>
        <DemoScope
          scenario={{
            id: "hibernation-test",
            app: "test-app",
            route: "/",
          }}
        >
          <Probe />
        </DemoScope>
      </PluginProvider>,
    );
    await waitFor(() => expect(mark).not.toBeNull());
    expect(await mark!("conv-1")).toEqual({ kind: "not-hibernated" });
  });
});
