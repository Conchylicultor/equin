import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as WebSdkCore from "@plugins/framework/plugins/web-sdk/core";

// The registry App.tsx boots from, replaced by a fake eager plugin per test
// that contributes one Core.Boot task (plus a Core.Root proving the app shows).
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

vi.mock("@plugins/framework/plugins/web-sdk/core", async (importOriginal) => {
  const real = await importOriginal<typeof WebSdkCore>();
  return {
    ...real,
    partitionWebEntries: <T,>(entries: T[]) => ({
      eager: entries,
      deferred: [],
    }),
  };
});

vi.mock(
  "@plugins/primitives/plugins/live-state/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    NotificationsProvider: ({ children }: { children: unknown }) => children,
    ensureNotificationsClient: () => {},
  }),
);

const reported = vi.hoisted(() => [] as { message: string }[]);
vi.mock("@plugins/reports/web", () => ({
  report: (body: { message: string }) => {
    reported.push(body);
    return Promise.resolve(null);
  },
}));

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import App from "../App";

/**
 * The boot root is never empty: while a Core.Boot task is pending App shows the
 * waiting boot screen; a rejected blocking task is a loud `failed` state, filed
 * as a report; the app renders once the task settles or the user continues.
 * (The deadline → `stuck` path is covered by boot-tasks.test.ts and the e2e.)
 */

function bootWith(run: () => Promise<void>) {
  registry.webEntries.length = 0;
  registry.webEntries.push({
    pluginPath: "shell/plugins/fake-boot",
    id: "shell.plugins.fake-boot",
    loader: async () => ({
      default: {
        description: "fake",
        contributions: [
          Core.Boot({ label: "Fake snapshot", ifUnavailable: "block", run }),
          Core.Root({ component: () => <div data-testid="app">app</div> }),
        ],
      },
    }),
    dependsOn: [],
  });
  return render(<App />);
}

const bootState = (c: HTMLElement) =>
  c.querySelector("[data-boot-state]")?.getAttribute("data-boot-state");

beforeEach(() => {
  resetDeferredLoadStateForTests();
  reported.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  resetDeferredLoadStateForTests();
  vi.restoreAllMocks();
});

describe("App — boot screen", () => {
  it("renders the boot screen in the first commit, then waits on the task", async () => {
    const { container } = bootWith(() => new Promise<void>(() => {}));
    expect(bootState(container)).toBe("waiting");
    await waitFor(() => {
      expect(container.textContent).toContain("Fake snapshot");
    });
    expect(bootState(container)).toBe("waiting");
    expect(reported).toEqual([]);
  });

  it("a rejected blocking task shows the failed state and reports it", async () => {
    const { container, getByRole, findByTestId } = bootWith(() =>
      Promise.reject(new Error("HTTP 503")),
    );
    await waitFor(() => expect(bootState(container)).toBe("failed"));
    expect(container.textContent).toContain("Fake snapshot failed: HTTP 503");
    expect(reported.map((r) => r.message)).toEqual([
      'boot: "Fake snapshot" failed: HTTP 503',
    ]);
    fireEvent.click(getByRole("button", { name: "Continue anyway" }));
    await findByTestId("app");
    expect(bootState(container)).toBeUndefined();
  });

  it("a task that resolves boots the app", async () => {
    const { container, findByTestId } = bootWith(async () => {});
    await findByTestId("app");
    expect(bootState(container)).toBeUndefined();
  });
});
