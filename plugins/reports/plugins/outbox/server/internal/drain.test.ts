import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { fileReportFromProcess, repositoryOf } from "../../core";
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

/** The repository `fileReportFromProcess` stamps from this test process. */
let thisRepo: string;
beforeAll(async () => {
  thisRepo = await repositoryOf(REPO_ROOT);
});

/** An entry written as raw JSON: a writer the test process cannot be. */
async function writeEntry(
  name: string,
  writer: OutboxEntry["writer"],
  code: OutboxCode | undefined,
): Promise<void> {
  const entry: OutboxEntry = {
    version: 1,
    kind: "k",
    message: "m",
    data: {},
    code,
    occurredAt: 1,
    writer,
  };
  await writeFile(join(dir, name), JSON.stringify(entry));
}

const CODE: OutboxCode = { mergeBase: MERGE_BASE, paths: ["a.ts"] };
const noStaleness = async (): Promise<never> => {
  throw new Error("the staleness rule must not run for another repository");
};

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
      repo: thisRepo,
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

  test("the writer stamps its repository", async () => {
    await fileReportFromProcess({ kind: "k", message: "m", data: {} }, { dir });
    const { deps, recorded } = harness();
    await drainOutbox(deps);
    expect(recorded[0]?.writer.repo).toBe(thisRepo);
    // Its own repository: filed as written, no origin note.
    expect(recorded[0]?.message).toBe("m");
  });

  test("another repository's entry is filed without the staleness rule, its message naming where it came from", async () => {
    await writeEntry(
      "5-1-abc.json",
      { pid: 7, checkout: "e2e-clone-wt", repo: "/tmp/e2e-clone" },
      CODE,
    );
    const { deps, recorded, failures } = harness({ staleness: noStaleness });
    const summary = await drainOutbox(deps);
    expect(summary.filed).toEqual(["5-1-abc.json"]);
    expect(failures).toHaveLength(0);
    expect(recorded[0]?.message).toContain(
      "filed from e2e-clone-wt in /tmp/e2e-clone",
    );
    expect(recorded[0]?.message).toContain("not checked for staleness");
    expect(await readdir(dir)).toHaveLength(0);
  });

  test("another repository's entry with no code still says where it came from", async () => {
    await writeEntry(
      "5-1-abc.json",
      { pid: 7, checkout: "e2e-clone-wt", repo: "/tmp/e2e-clone" },
      undefined,
    );
    const { deps, recorded } = harness({ staleness: noStaleness });
    await drainOutbox(deps);
    expect(recorded[0]?.message).toContain("filed from e2e-clone-wt");
  });

  test("an unstamped entry whose branch point is not here is filed, naming the missing commit", async () => {
    await writeEntry("5-1-abc.json", { pid: 7, checkout: "old-writer" }, CODE);
    const { deps, recorded, failures } = harness({
      staleness: async () => ({ kind: "unknown-commit" }),
    });
    const summary = await drainOutbox(deps);
    expect(summary.filed).toEqual(["5-1-abc.json"]);
    expect(failures).toHaveLength(0);
    expect(recorded[0]?.message).toContain(
      `branch point ${MERGE_BASE.slice(0, 12)} is not a commit of this repository`,
    );
  });

  test("this repository's entry whose branch point is not here is a failure, never filed or dropped", async () => {
    await writeEntry(
      "5-1-abc.json",
      { pid: 7, checkout: "wt", repo: thisRepo },
      CODE,
    );
    const { deps, recorded, failures } = harness({
      staleness: async () => ({ kind: "unknown-commit" }),
    });
    const summary = await drainOutbox(deps);
    expect(summary.failed).toEqual(["5-1-abc.json"]);
    expect(recorded).toHaveLength(0);
    expect(failures[0]?.message).toContain("is not a commit here");
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
