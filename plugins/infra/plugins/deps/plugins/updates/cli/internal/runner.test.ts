import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateResult } from "../../core/internal/compare";
import type { Gates } from "./gates";
import { runUpgrade } from "./runner";
import type { Move, Updater } from "../../core/internal/updater";

let root: string;
let syncs: string[];
beforeEach(() => {
  syncs = [];
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
    sync: async () => {
      syncs.push("fake");
    },
    smoke: async () => [{ name: "fake smoke", argv: ["true"], timeoutMs: 1 }],
    holds: { file: "fake.ts" },
  };
}

const PKG: Move = { name: "pkg", from: "1", to: "2" };
const PKG_MOVE: Move[] = [PKG];

/**
 * Gates answering from the lock's content: `before` while it says 1, `after`
 * once moved. `retry` answers `retried` when given, else from the lock too.
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
      return opts.retried ?? (moved() ? opts.after : opts.before);
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
    expect(receipt.culprits).toEqual([
      {
        moves: [{ updater: "fake", ...PKG }],
        regressions: [{ gate: "checks", failures: ["type-check"] }],
      },
    ]);
    expect(receipt.landed).toEqual([]);
    expect(syncs).toEqual(["fake"]);
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

  test("a gate that throws after the move aborts: the lock is put back and synced, the receipt says why", async () => {
    const gates: Gates = {
      all: async () => {
        if (readFileSync(join(root, "fake.lock"), "utf8").includes("= 2"))
          throw new Error("check runner crashed");
        return clean;
      },
      retry: async () => clean,
    };
    const receipt = await run(fakeUpdater(PKG_MOVE), gates);
    expect(receipt.verdict).toBe("aborted");
    expect(receipt.error).toContain("check runner crashed");
    expect(receipt.finishedAt).not.toBeNull();
    expect(readFileSync(join(root, "fake.lock"), "utf8")).toBe("pkg = 1\n");
    expect(syncs).toEqual(["fake"]);
    const onDisk = JSON.parse(readFileSync(join(root, "receipt.json"), "utf8"));
    expect(onDisk.verdict).toBe("aborted");
  });

  test("a throw before the move aborts without touching anything", async () => {
    const updater: Updater = {
      ...fakeUpdater(PKG_MOVE),
      plan: async () => {
        throw new Error("registry unreachable");
      },
    };
    const gates = fakeGates({ before: clean, after: clean });
    const receipt = await run(updater, gates);
    expect(receipt.verdict).toBe("aborted");
    expect(receipt.error).toContain("registry unreachable");
    expect(gates.calls).toEqual([]);
    expect(syncs).toEqual([]);
  });

  test("an apply that crashes is a regression with a verdict, not an abort", async () => {
    const updater: Updater = {
      ...fakeUpdater(PKG_MOVE),
      apply: async (r) => {
        writeFileSync(join(r, "fake.lock"), "pkg = 2\n");
        throw new Error(
          "regen-generated failed (exit 1):\nts.ScriptTarget is undefined",
        );
      },
    };
    const gates = fakeGates({ before: clean, after: clean });
    const receipt = await run(updater, gates);
    expect(receipt.verdict).toBe("regressed");
    expect(receipt.regressions).toEqual([
      { gate: "apply", failures: ["apply: regen-generated failed (exit 1):"] },
    ]);
    // Nothing coherent to gate once apply crashed.
    expect(gates.calls).toEqual(["baseline"]);
    expect(readFileSync(join(root, "fake.lock"), "utf8")).toBe("pkg = 1\n");
    expect(syncs).toEqual(["fake"]);
  });

  test("a batch moves every updater after ONE baseline, and lands the updater that does not regress", async () => {
    writeFileSync(join(root, "other.lock"), "dep = a\n");
    const other: Updater = {
      ...fakeUpdater([]),
      id: "other",
      files: async () => ["other.lock"],
      plan: async () => [{ name: "dep", from: "a", to: "b" }],
      apply: async (r) => writeFileSync(join(r, "other.lock"), "dep = b\n"),
      sync: async () => {
        syncs.push("other");
      },
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
    expect(gates.calls.slice(0, 3)).toEqual(["baseline", "candidate", "retry"]);
    expect(receipt.verdict).toBe("partial");
    expect(receipt.culprits.map((c) => c.moves.map((m) => m.name))).toEqual([
      ["pkg"],
    ]);
    expect(receipt.landed).toEqual([
      { updater: "other", name: "dep", from: "a", to: "b" },
    ]);
    // The tree holds exactly what landed.
    expect(readFileSync(join(root, "fake.lock"), "utf8")).toBe("pkg = 1\n");
    expect(readFileSync(join(root, "other.lock"), "utf8")).toBe("dep = b\n");
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

/**
 * A lock of many packages (`name = version` lines) whose gates fail one test
 * per moved package named in `breaks` — and, with `breaksOnlyWhole`, one more
 * that fails only while EVERY move is in (seen only by the full gates).
 */
describe("runUpgrade narrows a regressed batch down", () => {
  const NAMES = ["a", "b", "c", "d", "e", "f", "g", "h"];

  function manyUpdater(moves: Move[]): Updater {
    return {
      id: "many",
      description: "a test updater of many packages",
      files: async () => ["many.lock"],
      detect: async () => [],
      plan: async () => moves,
      apply: async (r, planned) => {
        const lock = readLock(r);
        for (const m of planned) lock.set(m.name, m.to);
        writeFileSync(
          join(r, "many.lock"),
          [...lock].map(([n, v]) => `${n} = ${v}\n`).join(""),
        );
      },
      sync: async () => {
        syncs.push("many");
      },
      smoke: async () => [],
      holds: { file: "many.ts" },
    };
  }

  function readLock(r: string): Map<string, string> {
    return new Map(
      readFileSync(join(r, "many.lock"), "utf8")
        .trim()
        .split("\n")
        .map((l) => l.split(" = ") as [string, string]),
    );
  }

  function breakingGates(
    breaks: readonly string[],
    breaksAlso?: (lock: Map<string, string>) => string | null,
  ): Gates {
    const now = (): GateResult[] => {
      const lock = readLock(root);
      const failures = breaks
        .filter((n) => lock.get(n) === "2.0.0")
        .map((n) => `${n}.test.ts > works`);
      const extra = breaksAlso?.(lock) ?? null;
      if (extra !== null) failures.push(extra);
      return [{ gate: "tests", failures }];
    };
    return {
      all: async () => now(),
      retry: async () => now(),
    };
  }

  beforeEach(() => {
    writeFileSync(
      join(root, "many.lock"),
      NAMES.map((n) => `${n} = 1.0.0\n`).join(""),
    );
  });

  const minor = (n: string, unit?: string): Move => ({
    name: n,
    from: "1.0.0",
    to: "2.0.0",
    ...(unit === undefined ? {} : { unit }),
  });

  async function runMany(moves: Move[], gates: Gates) {
    return runUpgrade({
      selection: [{ updater: manyUpdater(moves) }],
      root,
      receiptPath: join(root, "receipt.json"),
      gates,
      log: () => {},
    });
  }

  test("two culprits among eight: the other six land, each culprit named with what it broke", async () => {
    const receipt = await runMany(
      NAMES.map((n) => minor(n)),
      breakingGates(["c", "g"]),
    );
    expect(receipt.verdict).toBe("partial");
    expect(receipt.culprits).toEqual([
      {
        moves: [{ updater: "many", ...minor("c") }],
        regressions: [{ gate: "tests", failures: ["c.test.ts > works"] }],
      },
      {
        moves: [{ updater: "many", ...minor("g") }],
        regressions: [{ gate: "tests", failures: ["g.test.ts > works"] }],
      },
    ]);
    expect(receipt.landed.map((m) => m.name)).toEqual([
      "a",
      "b",
      "d",
      "e",
      "f",
      "h",
    ]);
    expect(receipt.untested).toEqual([]);
    const lock = readLock(root);
    expect(lock.get("c")).toBe("1.0.0");
    expect(lock.get("g")).toBe("1.0.0");
    expect(lock.get("a")).toBe("2.0.0");
    expect(receipt.probes.filter((p) => p.kind === "full")).toHaveLength(2);
    // Nothing put back: the tree holds what landed.
    expect(syncs).toEqual([]);
  });

  test("a lockstep unit is never split: its members land or fail together", async () => {
    const receipt = await runMany(
      [minor("a", "grp"), minor("b", "grp"), minor("c"), minor("d")],
      breakingGates(["b"]),
    );
    expect(receipt.verdict).toBe("partial");
    expect(receipt.culprits.map((c) => c.moves.map((m) => m.name))).toEqual([
      ["a", "b"],
    ]);
    expect(receipt.landed.map((m) => m.name)).toEqual(["c", "d"]);
    // Probes name units, and the group is one unit: never "many:a" alone.
    for (const p of receipt.probes)
      expect(p.units.some((u) => u === "many:a" || u === "many:b")).toBe(false);
  });

  test("a failure only the full gates see narrows again in a second round", async () => {
    // `h.test.ts > interop` fails while both e and f are in — the first round
    // targets only c's failure, so its kept set still holds e and f.
    const receipt = await runMany(
      NAMES.map((n) => minor(n)),
      breakingGates(["c"], (lock) =>
        lock.get("e") === "2.0.0" &&
        lock.get("f") === "2.0.0" &&
        lock.get("c") === "1.0.0"
          ? "h.test.ts > interop"
          : null,
      ),
    );
    expect(receipt.verdict).toBe("partial");
    expect(receipt.probes.filter((p) => p.kind === "full").length).toBe(3);
    const culprits = receipt.culprits.flatMap((c) =>
      c.moves.map((m) => m.name),
    );
    // Round 2 keeps a,b,d,e and finds f the one that breaks with e.
    expect(culprits).toEqual(["c", "f"]);
    const lock = readLock(root);
    expect(lock.get("e") === "2.0.0" && lock.get("f") === "2.0.0").toBe(false);
  });

  test("every unit regressing lands nothing: put back and synced", async () => {
    const receipt = await runMany(
      ["a", "b"].map((n) => minor(n)),
      breakingGates(["a", "b"]),
    );
    expect(receipt.verdict).toBe("regressed");
    expect(receipt.landed).toEqual([]);
    expect(receipt.culprits).toHaveLength(2);
    expect(readLock(root).get("a")).toBe("1.0.0");
    expect(syncs).toEqual(["many"]);
  });
});
