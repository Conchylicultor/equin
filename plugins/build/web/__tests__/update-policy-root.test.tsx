import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

// The policy's inputs, driven directly: the verdict, whether the tab is known
// to run the served build, and the page's readiness — and its one output, the
// quiet reload, watched instead of run.
const state = vi.hoisted(() => ({
  update: { kind: "current" } as { kind: string; [k: string]: unknown },
  current: false,
  readiness: {
    holds: [] as { label: string }[],
    engaged: false,
    hidden: false,
  },
  quietReload: vi.fn(() => new Promise<never>(() => {})),
  toast: vi.fn(),
}));
vi.mock("../hooks/use-tab-update", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTabUpdate: () => state.update,
}));
vi.mock("../hooks/use-stale-frontend", () => ({
  useStaleFrontend: () => ({
    stale: false,
    current: state.current,
    serverGraph: null,
  }),
}));
vi.mock(
  "@plugins/primitives/plugins/dom/plugins/reload-readiness/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useReloadReadiness: () => state.readiness,
    quietReload: state.quietReload,
  }),
);
vi.mock("@plugins/shell/plugins/notifications/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useToast: () => state.toast,
}));

import { act, cleanup, render } from "@testing-library/react";
import { UpdatePolicyRoot } from "../components/update-policy-root";
import { IDLE_BEFORE_UPDATE_MS } from "../internal/update-policy";
import { quietUpdate, resetUpdateState } from "../internal/update-state";

/** Longer than any wait the policy has: a reload not made by then never is. */
const LONG_AFTER_MS = 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  resetUpdateState();
  state.update = { kind: "current" };
  state.current = false;
  state.readiness = { holds: [], engaged: false, hidden: false };
  state.quietReload.mockClear();
  state.toast.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetUpdateState();
});

describe("UpdatePolicyRoot", () => {
  it("a hidden tab with an available update reloads at once", () => {
    state.update = { kind: "available", target: "g2" };
    state.readiness = { holds: [], engaged: false, hidden: true };
    render(<UpdatePolicyRoot />);
    expect(state.quietReload).toHaveBeenCalledTimes(1);
  });

  it("a visible tab waits until the user has been idle, then reloads", () => {
    state.update = { kind: "available", target: "g2" };
    render(<UpdatePolicyRoot />);
    expect(state.quietReload).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(IDLE_BEFORE_UPDATE_MS - 1));
    expect(state.quietReload).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(state.quietReload).toHaveBeenCalledTimes(1);
  });

  it("an engaged user restarts the idle wait", () => {
    state.update = { kind: "available", target: "g2" };
    const { rerender } = render(<UpdatePolicyRoot />);
    act(() => void vi.advanceTimersByTime(IDLE_BEFORE_UPDATE_MS - 1));
    state.readiness = { holds: [], engaged: true, hidden: false };
    rerender(<UpdatePolicyRoot />);
    state.readiness = { holds: [], engaged: false, hidden: false };
    rerender(<UpdatePolicyRoot />);
    act(() => void vi.advanceTimersByTime(IDLE_BEFORE_UPDATE_MS - 1));
    expect(state.quietReload).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(state.quietReload).toHaveBeenCalledTimes(1);
  });

  it("a held available update never reloads on its own", () => {
    state.update = { kind: "available", target: "g2" };
    state.readiness = {
      holds: [{ label: "Playback" }],
      engaged: false,
      hidden: true,
    };
    render(<UpdatePolicyRoot />);
    act(() => void vi.advanceTimersByTime(LONG_AFTER_MS));
    expect(state.quietReload).not.toHaveBeenCalled();
  });

  it("a required update reloads at once, even with the user engaged", () => {
    state.update = {
      kind: "required",
      why: "outdated",
      count: 1,
      target: "g2",
    };
    state.readiness = { holds: [], engaged: true, hidden: false };
    render(<UpdatePolicyRoot />);
    expect(state.quietReload).toHaveBeenCalledTimes(1);
  });

  it("a fault never reloads on its own", () => {
    state.update = { kind: "fault", failedPaths: ["apps/x"] };
    state.readiness = { holds: [], engaged: false, hidden: true };
    render(<UpdatePolicyRoot />);
    act(() => void vi.advanceTimersByTime(LONG_AFTER_MS));
    expect(state.quietReload).not.toHaveBeenCalled();
  });

  it("an update reload that came back behind on the same target does not loop", () => {
    // The page before: reloaded toward g2 while hidden.
    quietUpdate("g2", false);
    state.quietReload.mockClear();
    // This page: still behind, on the same target.
    state.update = { kind: "available", target: "g2" };
    state.readiness = { holds: [], engaged: false, hidden: true };
    render(<UpdatePolicyRoot />);
    act(() => void vi.advanceTimersByTime(LONG_AFTER_MS));
    expect(state.quietReload).not.toHaveBeenCalled();
  });

  it("a newer target after an update reload is a new update", () => {
    quietUpdate("g2", false);
    state.quietReload.mockClear();
    state.update = { kind: "available", target: "g3" };
    state.readiness = { holds: [], engaged: false, hidden: true };
    render(<UpdatePolicyRoot />);
    expect(state.quietReload).toHaveBeenCalledTimes(1);
  });

  it("after a visible update, says so once the tab is known to have landed", () => {
    quietUpdate("g2", true);
    const { rerender } = render(<UpdatePolicyRoot />);
    expect(state.toast).not.toHaveBeenCalled();
    state.current = true;
    rerender(<UpdatePolicyRoot />);
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "announcement",
        title: "Updated to the latest version",
        category: "updates",
      }),
    );
    rerender(<UpdatePolicyRoot />);
    expect(state.toast).toHaveBeenCalledTimes(1);
  });

  it("after a hidden update, says nothing", () => {
    quietUpdate("g2", false);
    state.current = true;
    render(<UpdatePolicyRoot />);
    expect(state.toast).not.toHaveBeenCalled();
  });
});
