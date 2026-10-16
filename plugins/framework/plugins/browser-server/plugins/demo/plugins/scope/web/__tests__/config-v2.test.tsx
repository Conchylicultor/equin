/**
 * config_v2's `Demo.Resource` inside a real `<DemoScope>`: `useConfig` reads
 * a descriptor's code defaults, the scopes map lists every web-registered path
 * with no scope, and a descriptor registered later (a lazy plugin) is pushed
 * to the open scope through `notify()` — the server is not rebuilt.
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
import type { DemoScenario } from "@plugins/framework/plugins/browser-server/plugins/demo/core";
import { definePack } from "@plugins/framework/plugins/browser-server/plugins/demo/core/testing";
import { Demo } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { configScopes, defineConfig } from "@plugins/config_v2/core";
import { ConfigV2, useConfig } from "@plugins/config_v2/web";
import { useConfigDemoServe } from "@plugins/config_v2/web/testing";
import { DemoScope } from "../components/demo-scope";

const toolbar = defineConfig({
  name: "toolbar",
  fields: {
    enabled: boolField({ label: "Enabled", default: true }),
    label: textField({ label: "Label", default: "Hello" }),
  },
});
const late = defineConfig({
  name: "late",
  fields: { on: boolField({ label: "On", default: false }) },
});

const scenario: DemoScenario = {
  id: "config-test",
  app: "test-app",
  route: "/",
  pack: () => Promise.resolve({ default: definePack(() => []) }),
};

function fixture(id: string, contributions: LoadedPlugin["contributions"]) {
  return {
    id: id as PluginId,
    description: `${id} fixture`,
    contributions,
  } as unknown as LoadedPlugin;
}
const base: LoadedPlugin[] = [
  {
    ...fixture("framework.browser-server.demo", []),
    slots: Demo,
  } as LoadedPlugin,
  {
    ...fixture("config_v2", [
      Demo.Resource({ id: "config-v2", useServe: useConfigDemoServe }),
    ]),
    slots: ConfigV2,
  } as LoadedPlugin,
  fixture("test.demo-config", [ConfigV2.WebRegister({ descriptor: toolbar })]),
];

function Probe<T>({ read, onRead }: { read: () => T; onRead: (v: T) => void }) {
  const value = read();
  useEffect(() => {
    onRead(value);
  });
  return null;
}

afterEach(cleanup);

/**
 * Render inside an awaited `act`: the scope suspends on its pack (`use()`),
 * and React only retries a suspended render from an act scope that is awaited.
 */
async function renderAsync(ui: ReactElement) {
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(ui);
  });
  return view!;
}

describe("config_v2 in a demo scope", () => {
  it("useConfig reads code defaults; a later registration is notified to the open scope", async () => {
    const seen: Record<string, unknown> = {};
    const tree = (plugins: LoadedPlugin[]) => (
      <PluginProvider plugins={plugins}>
        <DemoScope scenario={scenario}>
          <Probe
            read={() => useConfig(toolbar)}
            onRead={(v) => (seen.toolbar = v)}
          />
          <Probe
            read={() => useLive(configScopes)}
            onRead={(r) =>
              (seen.scopes = r.status === "ready" ? r.data : r.status)
            }
          />
        </DemoScope>
      </PluginProvider>
    );
    const view = await renderAsync(tree(base));
    await waitFor(() =>
      expect(seen.scopes).toEqual({ "test/demo-config/toolbar.jsonc": [] }),
    );
    expect(seen.toolbar).toEqual({ enabled: true, label: "Hello" });

    await act(async () => {
      view.rerender(
        tree([
          ...base,
          fixture("test.demo-late", [
            ConfigV2.WebRegister({ descriptor: late }),
          ]),
        ]),
      );
    });
    await waitFor(() =>
      expect(seen.scopes).toEqual({
        "test/demo-config/toolbar.jsonc": [],
        "test/demo-late/late.jsonc": [],
      }),
    );
  });
});
