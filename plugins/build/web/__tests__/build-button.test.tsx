import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

// The two reads the button branches on, driven directly: the build history
// (`useLive`) and the update affordance. Nothing here needs a server.
const state = vi.hoisted(() => ({
  history: {} as Record<string, unknown>,
  update: { kind: "current" } as { kind: string; [k: string]: unknown },
  affordance: { kind: "none" } as { kind: string; [k: string]: unknown },
  serverBehind: { behind: false } as { behind: boolean; count?: number },
}));
vi.mock("@plugins/network/plugins/live/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLive: () => state.history,
}));
vi.mock("../hooks/use-tab-update", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useServerBehind: () => state.serverBehind,
}));
vi.mock("../components/update-button", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useUpdateAffordance: () => ({
    update: state.update,
    affordance: state.affordance,
  }),
}));
vi.mock(
  "@plugins/network/plugins/live/plugins/live-state/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useNotificationsChannelStatuses: () => ({
      worktree: "open",
      central: "open",
    }),
  }),
);

import { cleanup, fireEvent, render } from "@testing-library/react";
import { ResourceError } from "@plugins/network/plugins/live/plugins/live-state/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { BuildButton } from "../components/build-button";

/**
 * The Builds button while the build history has no value. The incident: a tab
 * running a pre-deploy bundle whose history read failed forever rendered a
 * disabled wrench — reading as "loading" — and its early return hid the Reload
 * pill the tab needed.
 */

const READY = "A new version is ready — click to update";
const WAITING =
  "A new version is ready. Update waits for: Playback — click to update now";

afterEach(() => {
  cleanup();
  state.update = { kind: "current" };
  state.affordance = { kind: "none" };
  state.serverBehind = { behind: false };
});

describe("BuildButton without history", () => {
  it("loading: an inert wrench, alone when no reload is due", () => {
    state.history = {
      status: "loading",
      refetch: vi.fn(),
    };
    const { getAllByRole } = render(<BuildButton />);
    const buttons = getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Builds");
    expect(buttons[0]!.getAttribute("aria-disabled")).toBe("true");
  });

  it("loading + an overdue update: the Update pill still shows", () => {
    state.history = {
      status: "loading",
      refetch: vi.fn(),
    };
    state.update = { kind: "available", target: "g2" };
    state.affordance = { kind: "ready" };
    const { getByRole } = render(<BuildButton />);
    expect(getByRole("button", { name: READY })).not.toBeNull();
  });

  it("failed: a live wrench saying so, whose click retries — plus Update", () => {
    const refetch = vi.fn(() => Promise.resolve());
    state.history = {
      status: "error",
      error: new ResourceError(
        "loader-failed",
        "Resource build.history fetch failed: 500",
        null,
      ),
      refetch,
    };
    state.update = {
      kind: "required",
      why: "outdated",
      count: 1,
      target: null,
    };
    state.affordance = { kind: "waiting", waitsFor: ["Playback"] };
    const { getByRole } = render(<BuildButton />);
    const wrench = getByRole("button", {
      name: /couldn't load the build history.*Click to retry/i,
    }) as HTMLButtonElement;
    expect(wrench.disabled).toBe(false);
    fireEvent.click(wrench);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(getByRole("button", { name: WAITING })).not.toBeNull();
  });

  it("failed because the tab is out of date: the wrench offers the reload", () => {
    state.history = {
      status: "error",
      error: new ResourceError(
        "client-outdated",
        "This tab is out of date — reload to load this.",
        null,
      ),
      refetch: vi.fn(() => Promise.resolve()),
    };
    const { getByRole } = render(<BuildButton />);
    const wrench = getByRole("button", {
      name: /App updated — reload.*Click to reload/,
    }) as HTMLButtonElement;
    expect(wrench.disabled).toBe(false);
  });
});

/**
 * The Builds control with history: one quiet wrench at rest, otherwise the
 * tray — the status as a ghost button, an update the user can act on nested
 * at its end as the Update pill, and a failed build ringed in the solid
 * destructive fill.
 */
describe("BuildButton with history", () => {
  const run = (over: Record<string, unknown>) => ({
    id: "r1",
    trigger: "manual",
    commitHash: null,
    targets: [MAIN_COMPOSITION_ID],
    startedAt: new Date("2026-10-08T10:00:00Z"),
    finishedAt: new Date("2026-10-08T10:05:00Z"),
    exitCode: 0,
    ...over,
  });
  const trayOf = (el: HTMLElement) => el.closest(".rounded-full.bg-muted");

  it("idle, nothing due: the bare wrench, no tray", () => {
    state.history = { status: "ready", data: [run({})] };
    const { getAllByRole } = render(<BuildButton />);
    const buttons = getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Builds");
    expect(trayOf(buttons[0]!)).toBeNull();
  });

  it("a stale tab whose update has not come due: the bare wrench, nothing to say", () => {
    state.history = { status: "ready", data: [run({})] };
    state.update = { kind: "available", target: "g2" };
    const { getAllByRole } = render(<BuildButton />);
    const buttons = getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Builds");
  });

  it("a build running beside an overdue update: status and Update share one tray", () => {
    state.history = {
      status: "ready",
      data: [run({ finishedAt: null, exitCode: null })],
    };
    state.update = { kind: "available", target: "g2" };
    state.affordance = { kind: "ready" };
    const { getByRole } = render(<BuildButton />);
    const status = getByRole("button", { name: /Building/ });
    const update = getByRole("button", { name: READY });
    expect(trayOf(status)).not.toBeNull();
    expect(trayOf(status)).toBe(trayOf(update));
    // An update is not a fault: never the destructive fill.
    expect(update.className).not.toContain("bg-destructive-solid");
  });

  it("failed: the tray is ringed in the solid destructive fill", () => {
    state.history = { status: "ready", data: [run({ exitCode: 1 })] };
    const { getByRole } = render(<BuildButton />);
    const status = getByRole("button", { name: "Build failed" });
    expect(trayOf(status)?.className).toContain("ring-destructive-solid/45");
    expect(status.querySelector(".bg-destructive-solid")).not.toBeNull();
  });

  it("server behind the bundle it serves: says so, red, and offers no Reload", () => {
    state.history = { status: "ready", data: [run({ exitCode: 1 })] };
    state.serverBehind = { behind: true, count: 1 };
    const { getByRole, queryByRole } = render(<BuildButton />);
    const status = getByRole("button", { name: "Server out of date" });
    expect(trayOf(status)?.className).toContain("ring-destructive-solid/45");
    expect(status.querySelector(".bg-destructive-solid")).not.toBeNull();
    expect(queryByRole("button", { name: /reload/i })).toBeNull();
  });
});
