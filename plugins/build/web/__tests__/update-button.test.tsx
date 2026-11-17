import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  audience: "user" as "user" | "developer",
}));
vi.mock("@plugins/audience/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAudience: () => ({
    status: "ready",
    data: state.audience,
    refetch: () => Promise.resolve(),
  }),
}));

import { cleanup, fireEvent, render } from "@testing-library/react";
import type { TabUpdate } from "../hooks/use-tab-update";
import type { UpdateAffordance } from "../internal/update-policy";
import { UpdateButton } from "../components/update-button";

afterEach(() => {
  cleanup();
  state.audience = "user";
});

const AVAILABLE: TabUpdate = { kind: "available", target: "g2" };
const FAULT: TabUpdate = { kind: "fault", failedPaths: ["apps/x", "apps/y"] };

function renderPill(update: TabUpdate, affordance: UpdateAffordance) {
  return render(<UpdateButton update={update} affordance={affordance} />);
}

/**
 * The Update pill: an update is never a fault, so it is neutral; only a
 * failed load no update explains turns it red — for a developer, marked.
 */
describe("UpdateButton", () => {
  it("renders nothing when there is nothing to act on", () => {
    const { container } = renderPill(AVAILABLE, { kind: "none" });
    expect(container.textContent).toBe("");
  });

  it("an update held by a process: neutral, naming what it waits for", () => {
    const { getByRole } = renderPill(AVAILABLE, {
      kind: "waiting",
      waitsFor: ["Playback", "Upload"],
    });
    const pill = getByRole("button", {
      name: "A new version is ready. Update waits for: Playback, Upload — click to update now",
    });
    expect(pill.textContent).toBe("Update");
    expect(pill.className).not.toContain("bg-destructive-solid");
    expect(pill.className).not.toContain("bg-info-solid");
  });

  it("a pending update: neutral, offering it", () => {
    const { getByRole } = renderPill(AVAILABLE, { kind: "ready" });
    const pill = getByRole("button", {
      name: "A new version is ready — it updates itself at a quiet moment, or click to update now",
    });
    expect(pill.className).not.toContain("bg-destructive-solid");
  });

  it("a fault, for a user: the neutral retry, no detail", () => {
    const { getByRole } = renderPill(FAULT, {
      kind: "fault",
      failedPaths: ["apps/x", "apps/y"],
    });
    const pill = getByRole("button", {
      name: "Part of the app didn't load — click to retry",
    });
    expect(pill.textContent).toBe("Reload");
    expect(pill.className).not.toContain("bg-destructive-solid");
  });

  it("a fault, for a developer: red, naming the plugins", () => {
    state.audience = "developer";
    const { getByRole } = renderPill(FAULT, {
      kind: "fault",
      failedPaths: ["apps/x", "apps/y"],
    });
    const pill = getByRole("button", { name: /2 plugins failed to load/ });
    expect(pill.getAttribute("aria-label")).toContain("apps/x, apps/y");
    expect(pill.className).toContain("bg-destructive-solid");
  });

  describe("pressing it", () => {
    const reload = vi.fn();
    const realLocation = window.location;

    beforeEach(() => {
      reload.mockReset();
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...realLocation, reload },
      });
    });

    afterEach(() => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: realLocation,
      });
    });

    it("updates at once, even over a running process — the user chose to", () => {
      const { getByRole } = renderPill(AVAILABLE, {
        kind: "waiting",
        waitsFor: ["Playback"],
      });
      fireEvent.click(getByRole("button"));
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });
});
