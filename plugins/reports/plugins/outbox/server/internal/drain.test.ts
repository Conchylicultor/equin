import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileReportFromProcess } from "../../core";
import type { OutboxCode, OutboxEntry } from "../../core";
import { UNKNOWN_KIND_TTL_MS, drainOutbox, type DrainDeps } from "./drain";
import type { StalenessVerdict } from "./staleness";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "report-outbox-drain-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MERGE_BASE = "b".repeat(40);

function harness(
  overrides: {
    record?: (entry: OutboxEntry) => Promise<void>;
    staleness?: (code: OutboxCode) => Promise<StalenessVerdict>;
    recordFailure?: (error: Error) => Promise<void>;
    knownKinds?: readonly string[];
    now?: () => number;
  } = {},
): {
  deps: DrainDeps;
  recorded: OutboxEntry[];
  failures: Error[];
  logs: string[];
} {
  const recorded: OutboxEntry[] = [];
  const failures: Error[] = [];
  const logs: string[] = [];
  return {
    recorded,
    failures,
    logs,
    deps: {
      dir,
      record:
        overrides.record ??
        (async (entry) => {
          recorded.push(entry);
        }),
      recordFailure:
        overrides.recordFailure ??
        (async (error) => {
          failures.push(error);
        }),
      isKnownKind: (kind) => (overrides.knownKinds ?? ["k"]).includes(kind),
      checkStaleness:
        overrides.staleness ?? (async () => ({ kind: "current" }) as const),
      log: (line) => logs.push(line),
      now: overrides.now,
    },
  };
}

async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("drainOutbox", () => {
  test("a written entry is recorded, then deleted", async () => {
    await fileReportFromProcess(
      { kind: "k", message: "first", data: { a: 1 } },
      { dir, now: 1 },
    );
    await fileReportFromProcess(
      { kind: "k", message: "second", data: { a: 2 } },
      { dir, now: 2 },
    );
    const { deps, recorded, failures } = harness();
    const summary = await drainOutbox(deps);
    expect(summary.filed).toHaveLength(2);
    // Oldest first.
    expect(recorded.map((e) => e.message)).toEqual(["first", "second"]);
    expect(recorded[0]?.occurredAt).toBe(1);
    expect(failures).toHaveLength(0);
    expect(await readdir(dir)).toHaveLength(0);
  });

  test("an entry whose code main changed is dropped with its reason, and deleted", async () => {
    await fileReportFromProcess(
      {
        kind: "k",
        message: "m",
        data: {},
        code: { mergeBase: MERGE_BASE, paths: ["a.ts"] },
      },
      { dir },
    );
    const { deps, recorded, logs } = harness({
      staleness: async () => ({ kind: "stale", changed: ["a.ts"] }),
    });
    const summary = await drainOutbox(deps);
    expect(summary.dropped).toHaveLength(1);
    expect(recorded).toHaveLength(0);
    expect(logs.join("\n")).toContain("main changed a.ts");
    expect(await readdir(dir)).toHaveLength(0);
  });

  test("an entry from another repository is dropped, never a failure report", async () => {
    await fileReportFromProcess(
      {
        kind: "k",
        message: "m",
        data: {},
        code: { mergeBase: MERGE_BASE, paths: ["a.ts"] },
      },
      { dir },
    );
    const { deps, recorded, failures, logs } = harness({
      staleness: async () => ({ kind: "foreign" }),
    });
    const summary = await drainOutbox(deps);
    expect(summary.dropped).toHaveLength(1);
    expect(recorded).toHaveLength(0);
    expect(failures).toHaveLength(0);
    expect(logs.join("\n")).toContain("not a commit of this repository");
    expect(await readdir(dir)).toHaveLength(0);
  });

  test("bad JSON becomes a failure report, and the entry is deleted", async () => {
    await writeFile(join(dir, "5-1-abc.json"), "{not json");
    const { deps, recorded, failures } = harness();
    const summary = await drainOutbox(deps);
    expect(summary.failed).toEqual(["5-1-abc.json"]);
    expect(recorded).toHaveLength(0);
    expect(failures[0]?.message).toContain("5-1-abc.json");
    expect(await readdir(dir)).toHaveLength(0);
  });

  test("a KNOWN kind whose schema rejects the payload becomes a failure report", async () => {
    await fileReportFromProcess(
      { kind: "k", message: "m", data: { wrong: true } },
      { dir },
    );
    const { deps, failures } = harness({
      record: async () => {
        throw new Error("Expected number, received undefined at data.lateMs");
      },
    });
    const summary = await drainOutbox(deps);
    expect(summary.failed).toHaveLength(1);
    expect(failures[0]?.message).toContain("data.lateMs");
    expect(await readdir(dir)).toHaveLength(0);
  });

  test("an unknown kind younger than the TTL is left in place, logged once, no report", async () => {
    await fileReportFromProcess(
      { kind: "unmerged-kind", message: "m", data: {} },
      { dir, now: 1_000 },
    );
    const { deps, recorded, failures, logs } = harness({
      now: () => 1_000 + UNKNOWN_KIND_TTL_MS - 1,
      // Would throw if reached: an unknown kind is not worth a git spawn.
      staleness: async () => {
        throw new Error("staleness must not run for an unknown kind");
      },
    });
    const first = await drainOutbox(deps);
    const second = await drainOutbox(deps);
    expect(first.pending).toHaveLength(1);
    expect(second.pending).toHaveLength(1);
    expect(recorded).toHaveLength(0);
    expect(failures).toHaveLength(0);
    expect(logs.filter((l) => l.includes("unmerged-kind"))).toHaveLength(1);
    expect(await readdir(dir)).toHaveLength(1);
  });

  test("an unknown kind older than the TTL is deleted with a log line, no report", async () => {
    await fileReportFromProcess(
      { kind: "abandoned-kind", message: "m", data: {} },
      { dir, now: 1_000 },
    );
    const { deps, recorded, failures, logs } = harness({
      now: () => 1_000 + UNKNOWN_KIND_TTL_MS,
    });
    const summary = await drainOutbox(deps);
    expect(summary.expired).toHaveLength(1);
    expect(recorded).toHaveLength(0);
    expect(failures).toHaveLength(0);
    expect(logs.join("\n")).toContain('"abandoned-kind"');
    expect(await readdir(dir)).toHaveLength(0);
  });

  test("a staleness check that cannot decide is a failure, never a silent drop", async () => {
    await fileReportFromProcess(
      {
        kind: "k",
        message: "m",
        data: {},
        code: { mergeBase: MERGE_BASE, paths: ["a.ts"] },
      },
      { dir },
    );
    const { deps, recorded, failures } = harness({
      staleness: async () => {
        throw new Error("bad object");
      },
    });
    const summary = await drainOutbox(deps);
    expect(summary.failed).toHaveLength(1);
    expect(recorded).toHaveLength(0);
    expect(failures[0]?.message).toContain("bad object");
  });

  test("when even the failure report cannot be filed, the entry stays for the next pass", async () => {
    await writeFile(join(dir, "5-1-abc.json"), "{not json");
    const { deps } = harness({
      recordFailure: async () => {
        throw new Error("database down");
      },
    });
    const thrown = await captureThrow(() => drainOutbox(deps));
    expect(String(thrown)).toContain("database down");
    expect(await readdir(dir)).toEqual(["5-1-abc.json"]);
  });

  test("temp files: a fresh one is left to its writer, an abandoned one is removed", async () => {
    const fresh = ".10-1-abc.json.tmp";
    const old = ".11-1-def.json.tmp";
    await writeFile(join(dir, fresh), "{}");
    await writeFile(join(dir, old), "{}");
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(join(dir, old), hourAgo, hourAgo);
    const { deps, recorded } = harness();
    await drainOutbox(deps);
    expect(recorded).toHaveLength(0);
    expect(await readdir(dir)).toEqual([fresh]);
  });
});
