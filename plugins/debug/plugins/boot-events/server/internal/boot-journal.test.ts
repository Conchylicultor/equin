import { describe, expect, test } from "bun:test";
import { summariseBootJournals } from "./boot-journal";

const PSA = 1793829605950;

type Entry = Parameters<typeof summariseBootJournals>[0][number]["entry"];
const line = (entry: Entry, processStartedAt = PSA) => ({
  processStartedAt,
  entry,
});
const checkpoint = (label: string, atMs: number) =>
  line({ e: "checkpoint", checkpoint: { label, atMs } });
const open = (id: string, startMs: number) => line({ e: "open", id, startMs });
const span = (id: string, phase: string, startMs: number, durationMs: number) =>
  line({ e: "span", span: { id, phase, startMs, durationMs } });

describe("summariseBootJournals", () => {
  // The shape of a real boot the gateway SIGKILLed at its 130 s deadline
  // (att-1793828660-0jp1ka, 2026-11-04): imports done at 62 s, database's
  // blocking hook 14.7 s, then a hook that opened and never closed.
  test("a killed boot: imports, its slowest steps and the step it died in", () => {
    const boots = summariseBootJournals([
      checkpoint("boot-start", 66),
      checkpoint("darwinbg-at-start", 67),
      open("load:wave-1", 78),
      span("load:wave-1", "load", 78, 259),
      open("load:wave-18", 24390),
      span("load:wave-18", "load", 24390, 12913),
      checkpoint("after-import", 61820),
      open("onReadyBlocking:database", 62236),
      span("onReadyBlocking:database", "onReadyBlocking", 62236, 14703),
      open("onReadyBlocking:config_v2", 76950),
      open("onReadyBlocking:infra.jobs", 77029),
      span("onReadyBlocking:infra.jobs", "onReadyBlocking", 77029, 1501),
      span("routePopulation", "routePopulation", 61900, 60),
    ]);
    const boot = boots.get(PSA)!;
    expect(boot.importedAtMs).toBe(61820);
    expect(boot.diedIn).toEqual({
      id: "onReadyBlocking:config_v2",
      startMs: 76950,
    });
    expect(boot.slowest).toEqual([
      { id: "onReadyBlocking:database", ms: 14703 },
      { id: "load:wave-18", ms: 12913 },
      { id: "onReadyBlocking:infra.jobs", ms: 1501 },
    ]);
    expect(boot.lastEntryAtMs).toBe(78530);
    // Never moved out of darwinbg: demoted to its last entry.
    expect(boot.darwinbgMs).toBe(78530);
  });

  test("killed mid-import: no import checkpoint, died in the open wave", () => {
    const boot = summariseBootJournals([
      checkpoint("boot-start", 60),
      open("load:wave-1", 70),
      span("load:wave-1", "load", 70, 300),
      open("load:wave-2", 370),
    ]).get(PSA)!;
    expect(boot.importedAtMs).toBeNull();
    expect(boot.diedIn).toEqual({ id: "load:wave-2", startMs: 370 });
    expect(boot.darwinbgMs).toBeNull();
  });

  test("a boot the gateway moved out of darwinbg, and boots kept apart", () => {
    const boots = summariseBootJournals([
      checkpoint("boot-start", 60),
      checkpoint("darwinbg-at-start", 61),
      checkpoint("left-darwinbg", 15020),
      checkpoint("after-import", 18000),
      line(
        { e: "checkpoint", checkpoint: { label: "boot-start", atMs: 50 } },
        PSA + 1,
      ),
    ]);
    expect(boots.get(PSA)!.darwinbgMs).toBe(15020);
    expect(boots.get(PSA)!.diedIn).toBeNull();
    expect(boots.get(PSA + 1)!.lastEntryAtMs).toBe(50);
  });
});
