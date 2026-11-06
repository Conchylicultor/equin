import {
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { WriteOrigin } from "@plugins/infra/plugins/request-origin/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  defineAgentWriteLedger,
  listAgentWrites,
  revertAgentWritesIn,
  type AgentWriteLedgerEntry,
  type FileSnapshot,
} from "./ledger";

// Hermetic: the data root points at a throwaway dir, so no ledger file lands in
// the host's real `state/agent-write-ledger`. The root is read at call time and
// each ledger resolves its file on first use, which happens inside a test body,
// after this line. The ledger registry is process-global and never cleared (a
// duplicate id throws — that is the point), so every test uses ids of its own,
// and every revert assertion filters to them: `revertAgentWritesIn` walks every
// ledger this process ever defined.
const ORIGINAL_DATA_ROOT = readEnv("DIR");
const dataRoot = mkdtempSync(join(tmpdir(), "agent-write-ledger-root-"));
setEnv("DIR", dataRoot);
const files = asAppPath(
  mkdtempSync(join(tmpdir(), "agent-write-ledger-files-")),
);

afterAll(() => {
  if (ORIGINAL_DATA_ROOT === undefined) unsetEnv("DIR");
  else setEnv("DIR", ORIGINAL_DATA_ROOT);
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(files, { recursive: true, force: true });
});

const agent: WriteOrigin = {
  kind: "agent",
  source: "e2e:ledger-test",
  claimsUnreverted: false,
};
const E2E = { scope: "prefix", prefix: "e2e:" } as const;

type Role = "main" | "side";

/** A fresh pair of domain file paths (neither exists yet). */
function pathsFor(name: string): Record<Role, AppPath> {
  return {
    main: joinAppPath(files, `${name}.main.json`),
    side: joinAppPath(files, `${name}.side.json`),
  };
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/** What a domain's `restore` does: put `before` back, byte for byte. */
function putBack(entry: AgentWriteLedgerEntry<Role>): void {
  for (const role of ["main", "side"] as const) {
    const snap: FileSnapshot = entry.before[role];
    if (snap.present) writeFileSync(entry.paths[role], snap.bytes);
    else if (existsSync(entry.paths[role])) unlinkSync(entry.paths[role]);
  }
}

async function entriesOf(id: string) {
  const ledger = (await listAgentWrites()).ledgers.find((l) => l.id === id);
  if (!ledger) throw new Error(`ledger ${id} not listed`);
  return ledger.entries;
}

async function revertOnly(id: string) {
  const out = await revertAgentWritesIn(E2E);
  return {
    reverted: out.reverted.filter((r) => r.ledgerId === id),
    diverged: out.diverged.filter((r) => r.ledgerId === id),
    failed: out.failed.filter((r) => r.ledgerId === id),
  };
}

test("a user or system writer records nothing", async () => {
  const ledger = defineAgentWriteLedger<Role>({
    id: "test-non-agent",
    label: "Non-agent",
    restore: async () => {},
  });
  const paths = pathsFor("non-agent");
  await ledger.record({ kind: "user" }, "k", paths, "op");
  await ledger.record({ kind: "system", reason: "boot" }, "k", paths, "op");
  await ledger.noteComplete({ kind: "user" }, "k");
  expect(await entriesOf("test-non-agent")).toEqual([]);
  expect(
    existsSync(
      join(
        dataRoot,
        "state",
        "agent-write-ledger",
        runtimeNamespace(),
        "test-non-agent.json",
      ),
    ),
  ).toBe(false);
});

test("before is the first write's pre-state; after follows the last write", async () => {
  const seen: AgentWriteLedgerEntry<Role>[] = [];
  const ledger = defineAgentWriteLedger<Role>({
    id: "test-first-write",
    label: "First write",
    restore: async (entry) => {
      seen.push(entry);
      putBack(entry);
    },
  });
  const paths = pathsFor("first-write");
  writeFileSync(paths.main, "A");

  await ledger.record(agent, "doc", paths, "op-1");
  writeFileSync(paths.main, "B");
  writeFileSync(paths.side, "side-B");
  await ledger.noteComplete(agent, "doc");

  await ledger.record(agent, "doc", paths, "op-2");
  writeFileSync(paths.main, "C");
  await ledger.noteComplete(agent, "doc");

  const [listed] = await entriesOf("test-first-write");
  expect(listed?.key).toBe("doc");
  expect(listed?.source).toBe("e2e:ledger-test");
  expect(listed?.operations).toEqual(["op-1", "op-2"]);
  expect((await listAgentWrites()).lastWriteAt).not.toBeNull();

  // Persisted where the declaration says, one file per ledger per namespace.
  const ledgerFile = join(
    dataRoot,
    "state",
    "agent-write-ledger",
    runtimeNamespace(),
    "test-first-write.json",
  );
  expect(JSON.parse(readFileSync(ledgerFile, "utf-8")).version).toBe(1);

  const out = await revertOnly("test-first-write");
  expect(out.reverted).toEqual([
    {
      ledgerId: "test-first-write",
      label: "First write",
      key: "doc",
      source: "e2e:ledger-test",
    },
  ]);
  expect(seen[0]?.before).toEqual({
    main: { present: true, bytes: "A" },
    side: { present: false },
  });
  expect(seen[0]?.after).toEqual({
    main: { present: true, bytes: "C" },
    side: { present: true, bytes: "side-B" },
  });
  // The pre-agent state, not the agent's intermediate "B".
  expect(read(paths.main)).toBe("A");
  expect(read(paths.side)).toBeNull();
  expect(await entriesOf("test-first-write")).toEqual([]);

  // Idempotent: nothing left to do.
  expect(await revertOnly("test-first-write")).toEqual({
    reverted: [],
    diverged: [],
    failed: [],
  });
});

test("an entry someone wrote on top of is left alone and dropped", async () => {
  let restores = 0;
  const ledger = defineAgentWriteLedger<Role>({
    id: "test-diverged",
    label: "Diverged",
    restore: async (entry) => {
      restores += 1;
      putBack(entry);
    },
  });
  const paths = pathsFor("diverged");
  writeFileSync(paths.main, "user-original");

  await ledger.record(agent, "doc", paths, "op");
  writeFileSync(paths.main, "agent");
  await ledger.noteComplete(agent, "doc");

  // The user edits after the agent did.
  writeFileSync(paths.main, "user-later");

  const out = await revertOnly("test-diverged");
  expect(out.reverted).toEqual([]);
  expect(out.failed).toEqual([]);
  expect(out.diverged).toHaveLength(1);
  expect(out.diverged[0]?.label).toBe("Diverged");
  expect(out.diverged[0]?.key).toBe("doc");
  expect(out.diverged[0]?.detail).toContain("main");
  expect(restores).toBe(0);
  expect(read(paths.main)).toBe("user-later");
  expect(await entriesOf("test-diverged")).toEqual([]);
});

test("a failed restore stays in the ledger and is retried by the next revert", async () => {
  let broken = true;
  const ledger = defineAgentWriteLedger<Role>({
    id: "test-failed",
    label: "Failed",
    restore: async (entry) => {
      if (broken) throw new Error("disk on fire");
      putBack(entry);
    },
  });
  const paths = pathsFor("failed");

  await ledger.record(agent, "doc", paths, "op");
  writeFileSync(paths.main, "agent");
  await ledger.noteComplete(agent, "doc");

  const first = await revertOnly("test-failed");
  expect(first.failed).toEqual([
    {
      ledgerId: "test-failed",
      label: "Failed",
      key: "doc",
      message: "disk on fire",
    },
  ]);
  expect(first.reverted).toEqual([]);
  expect(await entriesOf("test-failed")).toHaveLength(1);
  expect(read(paths.main)).toBe("agent");

  broken = false;
  const second = await revertOnly("test-failed");
  expect(second.failed).toEqual([]);
  expect(second.reverted.map((r) => r.key)).toEqual(["doc"]);
  expect(read(paths.main)).toBeNull();
  expect(await entriesOf("test-failed")).toEqual([]);
});

test("one revert covers every registered ledger", async () => {
  const one = defineAgentWriteLedger<Role>({
    id: "test-aggregate-one",
    label: "Aggregate one",
    restore: async (entry) => putBack(entry),
  });
  const two = defineAgentWriteLedger<Role>({
    id: "test-aggregate-two",
    label: "Aggregate two",
    restore: async (entry) => putBack(entry),
  });
  const pathsOne = pathsFor("aggregate-one");
  const pathsTwo = pathsFor("aggregate-two");
  writeFileSync(pathsTwo.side, "two-original");

  await one.record(agent, "first", pathsOne, "op");
  writeFileSync(pathsOne.main, "agent-one");
  await one.noteComplete(agent, "first");

  await two.record(agent, "second", pathsTwo, "op");
  writeFileSync(pathsTwo.side, "agent-two");
  await two.noteComplete(agent, "second");

  const out = await revertAgentWritesIn(E2E);
  const mine = out.reverted.filter((r) =>
    r.ledgerId.startsWith("test-aggregate-"),
  );
  expect(mine).toEqual([
    {
      ledgerId: "test-aggregate-one",
      label: "Aggregate one",
      key: "first",
      source: "e2e:ledger-test",
    },
    {
      ledgerId: "test-aggregate-two",
      label: "Aggregate two",
      key: "second",
      source: "e2e:ledger-test",
    },
  ]);
  expect(read(pathsOne.main)).toBeNull();
  expect(read(pathsTwo.side)).toBe("two-original");
});

test("a revert restores only the sessions it names", async () => {
  const ledger = defineAgentWriteLedger<Role>({
    id: "test-scoped",
    label: "Scoped",
    restore: async (entry) => putBack(entry),
  });
  const a: WriteOrigin = {
    kind: "agent",
    source: "mcp-browser:conv-a",
    claimsUnreverted: false,
  };
  const b: WriteOrigin = {
    kind: "agent",
    source: "mcp-browser:conv-ab",
    claimsUnreverted: false,
  };
  const pathsA = pathsFor("scoped-a");
  const pathsB = pathsFor("scoped-b");

  await ledger.record(a, "a", pathsA, "op");
  writeFileSync(pathsA.main, "agent-a");
  await ledger.noteComplete(a, "a");
  await ledger.record(b, "b", pathsB, "op");
  writeFileSync(pathsB.main, "agent-b");
  await ledger.noteComplete(b, "b");

  // Neither the e2e family nor an exact source that is a prefix of another.
  const e2e = await revertAgentWritesIn(E2E);
  expect(e2e.reverted.filter((r) => r.ledgerId === "test-scoped")).toEqual([]);
  const onlyA = await revertAgentWritesIn({
    scope: "source",
    source: "mcp-browser:conv-a",
  });
  expect(
    onlyA.reverted
      .filter((r) => r.ledgerId === "test-scoped")
      .map((r) => r.key),
  ).toEqual(["a"]);
  expect(read(pathsA.main)).toBeNull();
  expect(read(pathsB.main)).toBe("agent-b");
  expect((await entriesOf("test-scoped")).map((e) => e.key)).toEqual(["b"]);
});

test("a ledger id is unique and names a file", () => {
  defineAgentWriteLedger<Role>({
    id: "test-unique",
    label: "Unique",
    restore: async () => {},
  });
  expect(() =>
    defineAgentWriteLedger<Role>({
      id: "test-unique",
      label: "Unique again",
      restore: async () => {},
    }),
  ).toThrow(/duplicate ledger id/);
  expect(() =>
    defineAgentWriteLedger<Role>({
      id: "Not/A/Segment",
      label: "Bad",
      restore: async () => {},
    }),
  ).toThrow(/ledger id must match/);
});

test("an agent write claiming to be unreverted is refused before it is recorded", async () => {
  const ledger = defineAgentWriteLedger<Role>({
    id: "test-claims-unreverted",
    label: "Claims unreverted",
    restore: async (entry) => putBack(entry),
  });
  const claimed: WriteOrigin = {
    kind: "agent",
    source: "mcp-browser:conv-claim",
    claimsUnreverted: true,
  };
  expect(
    ledger.record(claimed, "k", pathsFor("claims-unreverted"), "op"),
  ).rejects.toThrow(/agentReverted/);
  expect(await entriesOf("test-claims-unreverted")).toEqual([]);
});
