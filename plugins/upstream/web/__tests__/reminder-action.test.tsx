import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { UpdatesView } from "../internal/updates-view";

/**
 * The update reminder's action: Send agent to update + Remind me later, drawn
 * only while the release it names is the update to make; each later choice
 * writes its one setting and settles the notification.
 */

const spy = vi.hoisted(() => ({
  view: { kind: "absent" } as UpdatesView,
  writes: [] as [string, unknown][],
  accept: true,
}));

vi.mock("../internal/use-updates", () => ({
  useUpdatesView: () => spy.view,
}));

vi.mock("@plugins/config_v2/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSetConfig: () => (key: string, value: unknown) => {
    spy.writes.push([key, value]);
    return spy.accept;
  },
  // The merge prompt not read yet: Send agent is drawn disabled.
  useConfigResult: () => ({ status: "loading" }),
}));

import { updateReminderAction } from "../components/reminder-action";

afterEach(() => {
  cleanup();
  spy.writes = [];
  spy.accept = true;
  spy.view = { kind: "absent" };
});

const payload = { current: "v2026.10.30", latest: "v2026.11.14" };

function mount(done = vi.fn()) {
  const kind = updateReminderAction;
  if (kind.Control === undefined) throw new Error("not a Control kind");
  const { Control } = kind;
  render(<Control payload={payload} label={kind.label} done={done} />);
  return done;
}

describe("equin-update", () => {
  it("draws nothing once the release is no longer the update to make", () => {
    spy.view = {
      kind: "in-progress",
      current: "v2026.10.30",
      latest: "v2026.11.14",
      run: null,
    };
    mount();
    expect(screen.queryByText("Remind me later")).toBeNull();
    spy.view = {
      kind: "out-of-date",
      current: "v2026.11.14",
      latest: "v2026.11.20",
      commits: 6,
    };
    cleanup();
    mount();
    expect(screen.queryByText("Remind me later")).toBeNull();
  });

  it("offers Send agent and Remind me later while out of date", () => {
    spy.view = { kind: "out-of-date", ...payload, commits: 312 };
    mount();
    expect(
      screen.getByRole("button", { name: "Send agent to update" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Remind me later/ }),
    ).toBeTruthy();
  });

  it.each([
    ["Skip this release", ["skippedRelease", "v2026.11.14"]],
    ["Never", ["enabled", false]],
  ] as const)(
    "%s writes its setting and settles the notification",
    (label, write) => {
      spy.view = { kind: "out-of-date", ...payload, commits: 312 };
      const done = mount();
      act(() =>
        screen.getByRole("button", { name: /Remind me later/ }).click(),
      );
      act(() => screen.getByRole("menuitem", { name: label }).click());
      expect(spy.writes).toEqual([write]);
      expect(done).toHaveBeenCalledTimes(1);
    },
  );

  it("Tomorrow snoozes to tomorrow's check", () => {
    spy.view = { kind: "out-of-date", ...payload, commits: 312 };
    const done = mount();
    act(() => screen.getByRole("button", { name: /Remind me later/ }).click());
    act(() => screen.getByRole("menuitem", { name: "Tomorrow" }).click());
    const [[key, value]] = spy.writes as [[string, Date]];
    expect(key).toBe("snoozedUntil");
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setUTCHours(0, 0, 0, 0);
    expect(value).toEqual(tomorrow);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a refused write keeps the notification (the choice was not saved)", () => {
    spy.view = { kind: "out-of-date", ...payload, commits: 312 };
    spy.accept = false;
    const done = mount();
    act(() => screen.getByRole("button", { name: /Remind me later/ }).click());
    act(() => screen.getByRole("menuitem", { name: "Never" }).click());
    expect(done).not.toHaveBeenCalled();
  });

  it("draws its controls disabled while the update status is not known yet", () => {
    spy.view = { kind: "pending" };
    mount();
    expect(
      (
        screen.getByRole("button", {
          name: "Send agent to update",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
