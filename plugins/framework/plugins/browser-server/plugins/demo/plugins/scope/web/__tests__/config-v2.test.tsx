/**
 * config_v2's `Demo.Resource` inside a real `<DemoScope>`, over a fixture git
 * layer: `useConfig` reads the committed document (code defaults where the
 * git layer arranges nothing), the scopes map lists the committed `@app`
 * scopes, a descriptor registered later (a lazy plugin) is pushed to the open
 * scope through `notify()` — the server is not rebuilt — and a write
 * (`useSetConfig`) lands in the scope's in-memory user layer, live.
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
import { Demo } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { listField } from "@plugins/fields/plugins/list/plugins/config/core";
import {
  configScopes,
  defineConfig,
  setConfigField,
} from "@plugins/config_v2/core";
import { ConfigV2, useConfig, useSetConfig } from "@plugins/config_v2/web";
import {
  useConfigDemoBackend,
  type GitLayer,
} from "@plugins/config_v2/web/testing";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { DemoScope } from "../components/demo-scope";

const toolbar = defineConfig({
  name: "toolbar",
  fields: {
    enabled: boolField({ label: "Enabled", default: true }),
    label: textField({ label: "Label", default: "Hello" }),
  },
});
const chips = defineConfig({
  name: "chips",
  fields: {
    items: listField({
      label: "Items",
      itemFields: { title: textField({ label: "Title" }) },
      default: [],
    }),
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
};

function fixture(id: string, contributions: LoadedPlugin["contributions"]) {
  return {
    id: id as PluginId,
    description: `${id} fixture`,
    contributions,
  } as unknown as LoadedPlugin;
}
const TOOLBAR = "test/demo-config/toolbar.jsonc";
const CHIPS = "test/demo-config/chips.jsonc";
const gitLayer: GitLayer = {
  [TOOLBAR]: {
    base: { enabled: false, label: "Committed" },
    scopes: { "test-app": { enabled: true, label: "Committed" } },
  },
  // An id-less row, as authored config files hold them.
  [CHIPS]: { base: { items: [{ title: "Go" }] }, scopes: {} },
};
const loadGitLayer = () => Promise.resolve(gitLayer);
function useFixtureConfigBackend() {
  return useConfigDemoBackend(loadGitLayer);
}

const base: LoadedPlugin[] = [
  {
    ...fixture("framework.browser-server.demo", []),
    slots: Demo,
  } as LoadedPlugin,
  {
    ...fixture("config_v2", [
      Demo.Resource({ id: "config-v2", useBackend: useFixtureConfigBackend }),
    ]),
    slots: ConfigV2,
  } as LoadedPlugin,
  fixture("test.demo-config", [
    ConfigV2.WebRegister({ descriptor: toolbar }),
    ConfigV2.WebRegister({ descriptor: chips }),
  ]),
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
 * Render inside an awaited `act`, so the scope's server effect has run.
 */
async function renderAsync(ui: ReactElement) {
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(ui);
  });
  return view!;
}

describe("config_v2 in a demo scope", () => {
  it("useConfig reads the git layer; a later registration is notified to the open scope", async () => {
    const seen: Record<string, unknown> = {};
    const tree = (plugins: LoadedPlugin[]) => (
      <PluginProvider plugins={plugins}>
        <DemoScope scenario={scenario}>
          <Probe
            read={() => useConfig(toolbar)}
            onRead={(v) => (seen.toolbar = v)}
          />
          <Probe
            read={() => useConfig(toolbar, { scopeId: "app:test-app" })}
            onRead={(v) => (seen.scoped = v)}
          />
          <Probe
            read={() => useConfig(chips)}
            onRead={(v) => (seen.chips = v)}
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
      expect(seen.scopes).toEqual({ [TOOLBAR]: ["app:test-app"], [CHIPS]: [] }),
    );
    await waitFor(() => {
      expect(seen.toolbar).toEqual({ enabled: false, label: "Committed" });
      expect(seen.scoped).toEqual({ enabled: true, label: "Committed" });
      // The server's read path: an id-less list row gets its `auto-` id.
      expect(seen.chips).toEqual({
        items: [{ title: "Go", id: expect.stringMatching(/^auto-/) }],
      });
    });

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
        [TOOLBAR]: ["app:test-app"],
        [CHIPS]: [],
        "test/demo-late/late.jsonc": [],
      }),
    );
  });

  it("a write lands in the scope's user layer, live; a scoped write forks; a remount is the committed state", async () => {
    const seen: Record<string, unknown> = {};
    let set: ((key: "enabled" | "label", value: unknown) => void) | null = null;
    let setLate: ((key: "on", value: unknown) => void) | null = null;
    let fetchIn: ReturnType<typeof useFetchEndpoint> | null = null;
    const plugins = [
      ...base,
      fixture("test.demo-late", [ConfigV2.WebRegister({ descriptor: late })]),
    ];
    const tree = (key: string) => (
      <PluginProvider plugins={plugins}>
        <DemoScope key={key} scenario={scenario}>
          <Probe
            read={() => useConfig(toolbar)}
            onRead={(v) => (seen.toolbar = v)}
          />
          <Probe
            read={() => useConfig(late, { scopeId: "app:test-app" })}
            onRead={(v) => (seen.lateScoped = v)}
          />
          <Probe read={() => useConfig(late)} onRead={(v) => (seen.late = v)} />
          <Probe
            read={() => useLive(configScopes)}
            onRead={(r) =>
              (seen.scopes = r.status === "ready" ? r.data : r.status)
            }
          />
          <Probe read={() => useSetConfig(toolbar)} onRead={(f) => (set = f)} />
          <Probe
            read={() => useSetConfig(late, { scopeId: "app:test-app" })}
            onRead={(f) => (setLate = f)}
          />
          <Probe
            read={() => useFetchEndpoint()}
            onRead={(f) => (fetchIn = f)}
          />
        </DemoScope>
      </PluginProvider>
    );
    const view = await renderAsync(tree("first"));
    await waitFor(() =>
      expect(seen.toolbar).toEqual({ enabled: false, label: "Committed" }),
    );

    await act(async () => set!("label", "Edited"));
    await waitFor(() =>
      expect(seen.toolbar).toEqual({ enabled: false, label: "Edited" }),
    );

    // A scoped write to a scope with no document of its own forks it.
    await waitFor(() =>
      expect(seen.scopes).toEqual({
        [TOOLBAR]: ["app:test-app"],
        [CHIPS]: [],
        "test/demo-late/late.jsonc": [],
      }),
    );
    await act(async () => setLate!("on", true));
    await waitFor(() => {
      expect(seen.scopes).toEqual({
        [TOOLBAR]: ["app:test-app"],
        [CHIPS]: [],
        "test/demo-late/late.jsonc": ["app:test-app"],
      });
      expect(seen.lateScoped).toEqual({ on: true });
    });
    expect(seen.late).toEqual({ on: false });

    // An invalid value is refused, and nothing is stored.
    await expect(
      fetchIn!(
        setConfigField,
        {},
        {
          body: { storePath: TOOLBAR, key: "enabled", value: "nope" },
        },
      ),
    ).rejects.toThrow();
    expect(seen.toolbar).toEqual({ enabled: false, label: "Edited" });

    // A new mount is a new user layer: the committed state again.
    await act(async () => {
      view.rerender(tree("second"));
    });
    await waitFor(() =>
      expect(seen.toolbar).toEqual({ enabled: false, label: "Committed" }),
    );
  });
});
