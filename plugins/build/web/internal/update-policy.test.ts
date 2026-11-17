import { describe, expect, it } from "bun:test";
import type { ReloadReadiness } from "@plugins/primitives/plugins/dom/plugins/reload-readiness/web";
import type { TabUpdate } from "../hooks/use-tab-update";
import { updateAffordance, updateMoment } from "./update-policy";

const AVAILABLE: TabUpdate = { kind: "available", target: "g2" };
const REQUIRED: TabUpdate = {
  kind: "required",
  why: "outdated",
  count: 1,
  target: "g2",
};
const FAULT: TabUpdate = { kind: "fault", failedPaths: ["a/b"] };

function ready(over: Partial<ReloadReadiness> = {}): ReloadReadiness {
  return { holds: [], engaged: false, hidden: false, ...over };
}
const PLAYING = [
  { label: "Playback" },
  { label: "Playback" },
  { label: "Upload" },
];

describe("updateMoment", () => {
  it("never reloads a current tab, or a fault (a real bug, a reload only retries)", () => {
    expect(
      updateMoment({ kind: "current" }, ready({ hidden: true }), false),
    ).toBe("wait");
    expect(updateMoment(FAULT, ready({ hidden: true }), false)).toBe("wait");
  });

  it("available: hidden → now; visible and not engaged → when idle; engaged → wait", () => {
    expect(updateMoment(AVAILABLE, ready({ hidden: true }), false)).toBe(
      "reload-now",
    );
    expect(
      updateMoment(AVAILABLE, ready({ hidden: true, engaged: true }), false),
    ).toBe("reload-now");
    expect(updateMoment(AVAILABLE, ready(), false)).toBe("reload-when-idle");
    expect(updateMoment(AVAILABLE, ready({ engaged: true }), false)).toBe(
      "wait",
    );
  });

  it("available: a running process holds it, hidden or not", () => {
    expect(
      updateMoment(AVAILABLE, ready({ hidden: true, holds: PLAYING }), false),
    ).toBe("wait");
    expect(updateMoment(AVAILABLE, ready({ holds: PLAYING }), false)).toBe(
      "wait",
    );
  });

  it("required: now, engaged or held (quietReload waits out the holds itself)", () => {
    expect(updateMoment(REQUIRED, ready({ engaged: true }), false)).toBe(
      "reload-now",
    );
    expect(updateMoment(REQUIRED, ready({ holds: PLAYING }), false)).toBe(
      "reload-now",
    );
  });

  it("blocked (an update reload came back behind): never again on its own", () => {
    expect(updateMoment(AVAILABLE, ready({ hidden: true }), true)).toBe("wait");
    expect(updateMoment(REQUIRED, ready(), true)).toBe("wait");
  });
});

describe("updateAffordance", () => {
  const calm = { overdue: false, blocked: false };

  it("shows nothing for a current tab", () => {
    expect(updateAffordance({ kind: "current" }, ready(), calm)).toEqual({
      kind: "none",
    });
  });

  it("an available update waits silently until overdue", () => {
    expect(
      updateAffordance(AVAILABLE, ready({ holds: PLAYING }), calm),
    ).toEqual({
      kind: "none",
    });
    expect(
      updateAffordance(AVAILABLE, ready({ holds: PLAYING }), {
        overdue: true,
        blocked: false,
      }),
    ).toEqual({ kind: "waiting", waitsFor: ["Playback", "Upload"] });
    expect(
      updateAffordance(AVAILABLE, ready(), { overdue: true, blocked: false }),
    ).toEqual({
      kind: "ready",
    });
  });

  it("a required update shows only while held: it reloads the moment they release", () => {
    expect(updateAffordance(REQUIRED, ready(), calm)).toEqual({ kind: "none" });
    expect(
      updateAffordance(
        REQUIRED,
        ready({ holds: [{ label: "Recording" }] }),
        calm,
      ),
    ).toEqual({ kind: "waiting", waitsFor: ["Recording"] });
  });

  it("a blocked update is offered at once", () => {
    expect(
      updateAffordance(AVAILABLE, ready(), { overdue: false, blocked: true }),
    ).toEqual({
      kind: "ready",
    });
    expect(
      updateAffordance(REQUIRED, ready(), { overdue: false, blocked: true }),
    ).toEqual({
      kind: "ready",
    });
  });

  it("a fault is shown as a fault, whatever the flags", () => {
    expect(updateAffordance(FAULT, ready(), calm)).toEqual({
      kind: "fault",
      failedPaths: ["a/b"],
    });
  });
});
