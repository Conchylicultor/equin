import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateResult } from "../../core/internal/compare";
import type { Gates } from "./gates";
import { runUpgrade } from "./runner";
import type { Move, Updater } from "../../core/internal/updater";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deps-runner-"));
  writeFileSync(join(root, "fake.lock"), "pkg = 1\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** An updater that moves `pkg` in `fake.lock` from 1 to 2 (or nothing). */
function fakeUpdater(moves: Move[]): Updater {
  return {
    id: "fake",
    description: "a test updater",
    files: async () => ["fake.lock"],
    detect: async () =>
      moves.map((m) => ({ name: m.name, current: m.from, latest: m.to })),
    plan: async () => moves,
    apply: async (r, planned) => {
      for (const m of planned)
        writeFileSync(join(r, "fake.lock"), `${m.name} = ${m.to}\n`);
    },
    smoke: async () => [{ name: "fake smoke", argv: ["true"], timeoutMs: 1 }],
    holds: { file: "fake.ts" },
  };
}

const PKG: Move = { name: "pkg", from: "1", to: "2" };
const PKG_MOVE: Move[] = [PKG];

/**
 * Gates answering from the lock's content: `before` while it says 1, `after`
 * once moved. `retry` answers `retried` (default: the same as `after`).
 */
function fakeGates(opts: {
  before: GateResult[];
  after: GateResult[];
  retried?: GateResult[];
}): Gates & { calls: string[] } {
  const calls: string[] = [];
  const moved = () =>
    readFileSync(join(root, "fake.lock"), "utf8").includes("= 2");
  return {
    calls,
    all: async () => {
      calls.push(moved() ? "candidate" : "baseline");
      return moved() ? opts.after : opts.before;
    },
    retry: async () => {
      calls.push("retry");
      return opts.retried ?? opts.after;
    },
  };
}

const clean: GateResult[] = [
  { gate: "checks", failures: [] },
  { gate: "tests", failures: [] },
];

async function run(updater: Updater, gates: Gates) {
  return runUpgrade({
    selection: [{ updater }],
    root,
    receiptPath: join(root, "receipt.json"),
    gates,
    log: () => {},
  });
}

describe("runUpgrade verdicts", () => {
  test("current: nothing to move, no gate runs", async () => {
    const gates = fakeGates({ before: clean, after: clean });
    const receipt = await run(fakeUpdater([]), gates);
    expect(receipt.verdict).toBe("current");
    expect(gates.calls).toEqual([]);
  });

  test("upgraded: the lock moves and stays moved", async () => {
    const gates = fakeGates({ before: clean, after: clean });
    const receipt = await run(fakeUpdater(PKG_MOVE), gates);
    expect(receipt.verdict).toBe("upgraded");
    expect(gates.calls).toEqual(["baseline", "candidate"]);
    expect(readFileSync(join(root, "fake.lock"), "utf8")).toBe("pkg = 2\n");
    const onDisk = JSON.parse(readFileSync(join(root, "receipt.json"), "utf8"));
    expect(onDisk.verdict).toBe("upgraded");
    expect(onDisk.moves).toEqual([{ updater: "fake", ...PKG }]);
  });

  test("regressed: a failure only the candidate has, twice, puts the lock back", async () => {
    const broken = [
      { gate: "checks", failures: ["type-check"] },
      { gate: "tests", failures: [] },
    ];
    const gates = fakeGates({ before: clean, after: broken });
    const receipt = await run(fakeUpdater(PKG_MOVE), gates);
    expect(receipt.verdict).toBe("regressed");
    expect(receipt.regressions).toEqual([
      { gate: "checks", failures: ["type-check"] },
    ]);
    expect(gates.calls).toEqual(["baseline", "candidate", "retry"]);
    expect(readFileSync(join(root, "fake.lock"), "utf8")).toBe("pkg = 1\n");
  });

  test("a flaky candidate failure that passes on retry is not a regression", async () => {
    const gates = fakeGates({
      before: clean,
      after: [{ gate: "tests", failures: ["a.test.ts > flaky"] }],
      retried: [{ gate: "tests", failures: [] }],
    });
    const receipt = await run(fakeUpdater(PKG_MOVE), gates);
    expect(receipt.verdict).toBe("upgraded");
    expect(receipt.regressions).toEqual([]);
  });

  test("a failure the baseline already had is not blamed on the move", async () => {
    const alreadyBroken = [{ gate: "checks", failures: ["eslint"] }];
    const gates = fakeGates({ before: alreadyBroken, after: alreadyBroken });
    const receipt = await run(fakeUpdater(PKG_MOVE), gates);
    expect(receipt.verdict).toBe("upgraded");
    expect(gates.calls).toEqual(["baseline", "candidate"]);
  });

  test("a throw after the move puts the lock back and propagates", async () => {
    const updater = fakeUpdater(PKG_MOVE);
    const gates: Gates = {
      all: async () => {
        if (readFileSync(join(root, "fake.lock"), "utf8").includes("= 2"))
          throw new Error("check runner crashed");
        return clean;
      },
      retry: async () => clean,
    };
    const err = await run(updater, gates).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("check runner crashed");
    expect(readFileSync(join(root, "fake.lock"), "utf8")).toBe("pkg = 1\n");
  });

  test("a batch moves every updater's files after ONE baseline, and puts them all back on a regression", async () => {
    writeFileSync(join(root, "other.lock"), "dep = a\n");
    const other: Updater = {
      ...fakeUpdater([]),
      id: "other",
      files: async () => ["other.lock"],
      plan: async () => [{ name: "dep", from: "a", to: "b" }],
      apply: async (r) => writeFileSync(join(r, "other.lock"), "dep = b\n"),
      smoke: async () => [
        { name: "other smoke", argv: ["true"], timeoutMs: 1 },
      ],
    };
    const broken = [{ gate: "checks", failures: ["type-check"] }];
    const gates = fakeGates({ before: clean, after: broken });
    const receipt = await runUpgrade({
      selection: [{ updater: fakeUpdater(PKG_MOVE) }, { updater: other }],
      root,
      receiptPath: join(root, "receipt.json"),
      gates,
      log: () => {},
    });
    expect(receipt.updaters).toEqual(["fake", "other"]);
    expect(receipt.moves.map((m) => m.updater)).toEqual(["fake", "other"]);
    expect(gates.calls).toEqual(["baseline", "candidate", "retry"]);
    expect(receipt.verdict).toBe("regressed");
    expect(readFileSync(join(root, "fake.lock"), "utf8")).toBe("pkg = 1\n");
    expect(readFileSync(join(root, "other.lock"), "utf8")).toBe("dep = a\n");
  });

  test("a batch where only some updaters are outdated moves just those", async () => {
    const gates = fakeGates({ before: clean, after: clean });
    const receipt = await runUpgrade({
      selection: [
        { updater: { ...fakeUpdater([]), id: "idle" } },
        { updater: fakeUpdater(PKG_MOVE) },
      ],
      root,
      receiptPath: join(root, "receipt.json"),
      gates,
      log: () => {},
    });
    expect(receipt.verdict).toBe("upgraded");
    expect(receipt.moves).toEqual([{ updater: "fake", ...PKG }]);
  });
});
