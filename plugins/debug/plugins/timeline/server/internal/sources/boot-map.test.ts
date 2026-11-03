import { describe, expect, test } from "bun:test";
import { mapBootEvents } from "./boot-map";

const T0 = Date.parse("2026-07-10T09:00:00.000Z");
const fromMs = T0;
const toMs = T0 + 60 * 60 * 1000;

describe("mapBootEvents", () => {
  test("maps a ready boot to the interval [processStartedAt, readyAt]", () => {
    const start = T0 + 5 * 60 * 1000;
    const ready = start + 12_000;
    const [ev] = mapBootEvents(
      [
        {
          processStartedAt: start,
          readyAt: ready,
          exitedAt: null,
          supersededAtMs: null,
        },
      ],
      "wt-a",
      fromMs,
      toMs,
    );
    expect(ev).toEqual({
      id: `boot:wt-a:${ready}`,
      source: "boot",
      worktree: "wt-a",
      startMs: start,
      endMs: ready,
      label: "backend boot",
      severity: "info",
      detail: { processStartedAt: start, readyAt: ready, bootMs: 12_000 },
    });
  });

  test("keeps a boot straddling the window edge, drops one fully outside", () => {
    const straddling = {
      processStartedAt: fromMs - 5000,
      readyAt: fromMs + 5000,
      exitedAt: null,
      supersededAtMs: null,
    };
    const outside = {
      processStartedAt: fromMs - 60_000,
      readyAt: fromMs - 30_000,
      exitedAt: null,
      supersededAtMs: null,
    };
    const events = mapBootEvents([straddling, outside], "wt-a", fromMs, toMs);
    expect(events.length).toBe(1);
    expect(events[0]!.startMs).toBe(fromMs - 5000);
  });

  test("a never-ready latest boot renders open-ended to toMs with the in-flight pulse", () => {
    const start = T0 + 5 * 60 * 1000;
    const [ev] = mapBootEvents(
      [
        {
          processStartedAt: start,
          readyAt: null,
          exitedAt: null,
          supersededAtMs: null,
        },
      ],
      "wt-a",
      fromMs,
      toMs,
    );
    expect(ev).toEqual({
      id: `boot:wt-a:start:${start}`,
      source: "boot",
      worktree: "wt-a",
      startMs: start,
      endMs: toMs,
      label: "backend boot (in progress or wedged)",
      severity: "info",
      detail: { processStartedAt: start, readyAt: null, supersededAtMs: null, inFlight: true },
    });
  });

  test("a superseded never-ready boot is a bounded warning bar", () => {
    const start = T0 + 5 * 60 * 1000;
    const next = start + 30_000;
    const [ev] = mapBootEvents(
      [
        {
          processStartedAt: start,
          readyAt: null,
          exitedAt: null,
          supersededAtMs: next,
        },
      ],
      "wt-a",
      fromMs,
      toMs,
    );
    expect(ev).toMatchObject({
      startMs: start,
      endMs: next,
      label: "backend boot (never ready)",
      severity: "warning",
      detail: { supersededAtMs: next, inFlight: false },
    });
  });

  test("a boot that exited before ready is a crash bar ending at its exit, not at its successor", () => {
    const start = T0 + 5 * 60 * 1000;
    const exited = start + 3_000;
    const [ev] = mapBootEvents(
      [
        {
          processStartedAt: start,
          readyAt: null,
          exitedAt: exited,
          supersededAtMs: start + 170_000,
        },
      ],
      "wt-a",
      fromMs,
      toMs,
    );
    expect(ev).toMatchObject({
      startMs: start,
      endMs: exited,
      label: "backend boot (crashed)",
      severity: "warning",
      detail: { exitedAt: exited, bootMs: 3_000 },
    });
  });

  test("an old never-ready open boot still overlaps any later window (it is STILL not ready)", () => {
    const start = fromMs - 24 * 60 * 60 * 1000;
    const events = mapBootEvents(
      [
        {
          processStartedAt: start,
          readyAt: null,
          exitedAt: null,
          supersededAtMs: null,
        },
      ],
      "wt-a",
      fromMs,
      toMs,
    );
    expect(events.length).toBe(1);
    expect(events[0]!.endMs).toBe(toMs);
  });
});
