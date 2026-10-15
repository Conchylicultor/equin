import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as WebSdkCore from "@plugins/framework/plugins/web-sdk/core";

// The registry App.tsx boots from, replaced by a handful of fake entries the
// test controls. Filled per test (in place — the module exports ONE array).
const registry = vi.hoisted(() => ({
  webEntries: [] as {
    pluginPath: string;
    id: string;
    loader: () => Promise<{ default: unknown }>;
    dependsOn: string[];
  }[],
  composition: { id: "singularity", home: null },
}));
vi.mock("@composition-web-registry", () => registry);

// Stage membership is a generated set; the test decides it instead, so it
// cannot break when a real plugin moves between stages. Everything else in
// web-sdk (the loader, PluginProvider, the deferred-load store) stays real.
vi.mock("@plugins/framework/plugins/web-sdk/core", async (importOriginal) => {
  const real = await importOriginal<typeof WebSdkCore>();
  return {
    ...real,
    partitionWebEntries: <T extends { pluginPath: string }>(entries: T[]) => ({
      eager: entries.filter((e) => !e.pluginPath.startsWith("apps/")),
      deferred: entries.filter((e) => e.pluginPath.startsWith("apps/")),
    }),
  };
});

// No live-state transport in jsdom: the provider is a pass-through and the
// transport hoist a no-op. Neither is what this suite is about.
vi.mock(
  "@plugins/primitives/plugins/live-state/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    NotificationsProvider: ({ children }: { children: unknown }) => children,
    ensureNotificationsClient: () => {},
  }),
);

import { cleanup, render, waitFor } from "@testing-library/react";
import {
  getDeferredLoadState,
  pluginLoadReportSink,
  type PluginLoadReport,
} from "@plugins/framework/plugins/web-sdk/core";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import App from "../App";

/**
 * Which plugin-load failures get the full-width boot banner.
 *
 * Only the core stage's. A plugin that fails while the app is already on
 * screen (the deferred tier) is published on the deferred-load store and
 * reported — the Build button's Reload chip turns red — but never reaches the
 * banner: a stale background tab once came back wearing a banner listing 64
 * such plugins.
 */

function ok(pluginPath: string) {
  return {
    pluginPath,
    id: pluginPath.replace(/\//g, "."),
    loader: async () => ({
      default: { description: pluginPath, contributions: [] },
    }),
    dependsOn: [],
  };
}

function broken(pluginPath: string) {
  return {
    pluginPath,
    id: pluginPath.replace(/\//g, "."),
    loader: () =>
      Promise.reject(
        new TypeError(
          `Failed to fetch dynamically imported module: /artifacts/${pluginPath}`,
        ),
      ),
    dependsOn: [],
  };
}

const EAGER_OK = "shell/plugins/fake-ok";
const EAGER_BROKEN = "shell/plugins/fake-broken";
const DEFERRED_OK = "apps/plugins/fake/plugins/ok";
const DEFERRED_BROKEN = "apps/plugins/fake/plugins/broken";

const reports: PluginLoadReport[] = [];

beforeEach(() => {
  resetDeferredLoadStateForTests();
  reports.length = 0;
  pluginLoadReportSink.register((r) => reports.push(r));
  // The loader logs each failure; that is the product's own loud path, and
  // noise here.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  pluginLoadReportSink.register(null);
  resetDeferredLoadStateForTests();
  vi.restoreAllMocks();
});

async function boot(entries: typeof registry.webEntries) {
  registry.webEntries.length = 0;
  registry.webEntries.push(...entries);
  const utils = render(<App />);
  await waitFor(() => {
    expect(getDeferredLoadState().deferredComplete).toBe(true);
  });
  return utils;
}

describe("App — plugin-load failures by stage", () => {
  it("a deferred failure never reaches the banner, but is published and reported", async () => {
    const { container } = await boot([
      ok(EAGER_OK),
      ok(DEFERRED_OK),
      broken(DEFERRED_BROKEN),
    ]);

    expect(container.textContent).not.toContain(DEFERRED_BROKEN);
    expect(container.querySelector(".bg-destructive")).toBeNull();

    expect([...getDeferredLoadState().failedPluginPaths]).toEqual([
      DEFERRED_BROKEN,
    ]);
    expect(reports.map((r) => r.pluginPath)).toEqual([DEFERRED_BROKEN]);
  });

  it("a core failure gets the banner; a deferred failure in the same boot still does not", async () => {
    const { container } = await boot([
      ok(EAGER_OK),
      broken(EAGER_BROKEN),
      broken(DEFERRED_BROKEN),
    ]);

    const banner = container.querySelector(".bg-destructive");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain(EAGER_BROKEN);
    expect(banner?.textContent).not.toContain(DEFERRED_BROKEN);

    // Both stages still reach the store and the report sink.
    expect([...getDeferredLoadState().failedPluginPaths].sort()).toEqual(
      [DEFERRED_BROKEN, EAGER_BROKEN].sort(),
    );
    expect(reports.map((r) => r.pluginPath).sort()).toEqual(
      [DEFERRED_BROKEN, EAGER_BROKEN].sort(),
    );
  });

  it("no failures, no banner", async () => {
    const { container } = await boot([ok(EAGER_OK), ok(DEFERRED_OK)]);
    expect(container.querySelector(".bg-destructive")).toBeNull();
    expect(getDeferredLoadState().failedPluginPaths.size).toBe(0);
  });
});
