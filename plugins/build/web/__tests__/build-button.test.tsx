import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

// The two reads the button branches on, driven directly: the build history
// (`useLive`) and the reload advice. Nothing here needs a server.
const state = vi.hoisted(() => ({
  history: {} as Record<string, unknown>,
  advice: { kind: "none" } as { kind: string; [k: string]: unknown },
}));
vi.mock("@plugins/network/plugins/live/web", () => ({
  useLive: () => state.history,
}));
vi.mock("../hooks/use-reload-advice", () => ({
  useReloadAdvice: () => state.advice,
}));
vi.mock(
  "@plugins/primitives/plugins/live-state/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useNotificationsChannelStatuses: () => ({
      worktree: "open",
      central: "open",
    }),
  }),
);

import { cleanup, fireEvent, render } from "@testing-library/react";
import { ResourceError } from "@plugins/primitives/plugins/live-state/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { BuildButton } from "../components/build-button";

/**
 * The Builds button while the build history has no value. The incident: a tab
 * running a pre-deploy bundle whose history read failed forever rendered a
 * disabled wrench — reading as "loading" — and its early return hid the Reload
 * pill the tab needed.
 */

const STALE = "Server was rebuilt — click to reload this tab";
const OUTDATED =
  "This tab is out of date and can't load some data — reload to fix";

afterEach(() => {
  cleanup();
  state.advice = { kind: "none" };
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
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("loading + stale tab: the Reload pill still shows", () => {
    state.history = {
      status: "loading",
      refetch: vi.fn(),
    };
    state.advice = { kind: "stale" };
    const { getByRole } = render(<BuildButton />);
    expect(getByRole("button", { name: STALE })).not.toBeNull();
  });

  it("failed: a live wrench saying so, whose click retries — plus Reload", () => {
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
    state.advice = { kind: "outdated", stale: false, count: 1 };
    const { getByRole } = render(<BuildButton />);
    const wrench = getByRole("button", {
      name: /couldn't load the build history.*Click to retry/i,
    }) as HTMLButtonElement;
    expect(wrench.disabled).toBe(false);
    fireEvent.click(wrench);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(getByRole("button", { name: OUTDATED })).not.toBeNull();
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
 * tray — the status as a ghost button, a due reload nested at its end as the
 * filled Reload pill, and a failed build ringed in the solid destructive fill.
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

  it("server updated under a stale tab: status and Reload share one tray", () => {
    state.history = { status: "ready", data: [run({})] };
    state.advice = { kind: "stale" };
    const { getByRole } = render(<BuildButton />);
    const status = getByRole("button", { name: "Server updated" });
    const reload = getByRole("button", { name: STALE });
    expect(trayOf(status)).not.toBeNull();
    expect(trayOf(status)).toBe(trayOf(reload));
    expect(reload.className).toContain("bg-info-solid");
  });

  it("failed: the tray is ringed in the solid destructive fill", () => {
    state.history = { status: "ready", data: [run({ exitCode: 1 })] };
    const { getByRole } = render(<BuildButton />);
    const status = getByRole("button", { name: "Build failed" });
    expect(trayOf(status)?.className).toContain("ring-destructive-solid/45");
    expect(status.querySelector(".bg-destructive-solid")).not.toBeNull();
  });
});
