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
  it("shows nothing for a current tab", () => {
    expect(updateAffordance({ kind: "current" }, ready())).toEqual({
      kind: "none",
    });
  });

  it("an available update is shown at once, whatever the moment", () => {
    expect(updateAffordance(AVAILABLE, ready())).toEqual({ kind: "ready" });
    expect(updateAffordance(AVAILABLE, ready({ engaged: true }))).toEqual({
      kind: "ready",
    });
    expect(updateAffordance(AVAILABLE, ready({ holds: PLAYING }))).toEqual({
      kind: "waiting",
      waitsFor: ["Playback", "Upload"],
    });
  });

  it("a required update is shown too, naming what holds it", () => {
    expect(updateAffordance(REQUIRED, ready())).toEqual({ kind: "ready" });
    expect(
      updateAffordance(REQUIRED, ready({ holds: [{ label: "Recording" }] })),
    ).toEqual({ kind: "waiting", waitsFor: ["Recording"] });
  });

  it("a fault is shown as a fault", () => {
    expect(updateAffordance(FAULT, ready())).toEqual({
      kind: "fault",
      failedPaths: ["a/b"],
    });
  });
});
