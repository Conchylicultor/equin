import { describe, expect, test } from "bun:test";
import { defineDataDir, getDataDirs } from "./data-dir";
import type { DataDir } from "./data-dir";
import {
  declaredSets,
  describeAttribution,
  partitionByOwner,
} from "./data-dirs-manifest";
import type { DataDirsManifest } from "./data-dirs-manifest";

function manifest(
  namespace: string,
  sets: { keys?: string[]; rootEntries?: string[] },
): DataDirsManifest {
  return {
    version: 1,
    namespace,
    writtenAt: "2026-09-01T00:00:00.000Z",
    keys: sets.keys ?? [],
    rootEntries: sets.rootEntries ?? [],
    logClaims: [],
  };
}

describe("declaredSets", () => {
  test("keys are kind/name pairs, sorted", () => {
    // Real declarations, never a `{} as DataDir` stand-in: `declaredSets` reads
    // `.spec` off every entry, so a hollow cast tests a shape the registry
    // never produces and fails for a reason the code does not have.
    const config = defineDataDir({
      kind: "state",
      name: "test-sorted-config",
      owner: "infra/paths",
      description: "test",
      reclaim: { kind: "safe" },
    });
    const cache = defineDataDir({
      kind: "cache",
      name: "test-sorted-check",
      owner: "infra/paths",
      description: "test",
      reclaim: { kind: "safe" },
    });
    const declared = new Map<string, DataDir>([
      ["state/test-sorted-config", config],
      ["cache/test-sorted-check", cache],
    ]);
    expect(declaredSets(declared).keys).toEqual([
      "cache/test-sorted-check",
      "state/test-sorted-config",
    ]);
  });

  test("rootEntries is the FIRST segment of each legacyLocation, deduped", () => {
    // A legacy path may reach deeper than the root's own listing; what such a
    // declaration clears is exactly one top-level entry.
    const deep = defineDataDir({
      kind: "services",
      name: "test-deep-legacy",
      owner: "infra/paths",
      description: "test",
      reclaim: { kind: "safe" },
      legacyLocation: { path: "services/inner/leaf", reason: "test" },
    });
    const sibling = defineDataDir({
      kind: "services",
      name: "test-sibling-legacy",
      owner: "infra/paths",
      description: "test",
      reclaim: { kind: "safe" },
      legacyLocation: { path: "services/other", reason: "test" },
    });
    const sets = declaredSets(
      new Map([
        ["services/test-deep-legacy", deep],
        ["services/test-sibling-legacy", sibling],
      ]),
    );
    expect(sets.rootEntries).toEqual(["services"]);
  });

  test("a declaration without legacyLocation contributes no root entry", () => {
    const plain = defineDataDir({
      kind: "cache",
      name: "test-plain",
      owner: "infra/paths",
      description: "test",
      reclaim: { kind: "safe" },
    });
    expect(declaredSets(new Map([["cache/test-plain", plain]]))).toEqual({
      keys: ["cache/test-plain"],
      rootEntries: [],
      logClaims: [],
    });
  });

  test("reads the live registry, so computed names are included", () => {
    // The reason the manifest is derived from the EVALUATED registry rather than
    // from parsing sources: `infra/host/host-admission` mints one `locks/<id>`
    // declaration per pool, so those names appear nowhere as literals.
    defineDataDir({
      kind: "locks",
      name: `test-computed-${"pool"}`,
      owner: "infra/paths",
      description: "test",
      reclaim: { kind: "restart" },
    });
    expect(declaredSets(getDataDirs()).keys).toContain(
      "locks/test-computed-pool",
    );
  });
});

describe("partitionByOwner", () => {
  const foreign = [
    manifest("att-a", { keys: ["state/agent-write-ledger"] }),
    manifest("att-b", {
      keys: ["state/agent-write-ledger", "cache/thing"],
      rootEntries: ["postgres"],
    }),
  ];

  test("an entry another live namespace declares is attributed, not an orphan", () => {
    const split = partitionByOwner(
      ["state/agent-write-ledger"],
      foreign,
      "keys",
    );
    expect(split.orphans).toEqual([]);
    expect(split.attributed.get("state/agent-write-ledger")).toEqual([
      "att-a",
      "att-b",
    ]);
  });

  test("an entry nobody declares stays an orphan", () => {
    const split = partitionByOwner(["state/nobody"], foreign, "keys");
    expect(split.orphans).toEqual(["state/nobody"]);
    expect(split.attributed.size).toBe(0);
  });

  test("orphans keep the order they were given", () => {
    const split = partitionByOwner(
      ["state/z", "state/agent-write-ledger", "state/a"],
      foreign,
      "keys",
    );
    expect(split.orphans).toEqual(["state/z", "state/a"]);
  });

  test("the two sets do not cross: a key never matches a rootEntry", () => {
    // `postgres` is a top-level entry in att-b's manifest, not a `${kind}/${name}`.
    expect(partitionByOwner(["postgres"], foreign, "keys").orphans).toEqual([
      "postgres",
    ]);
    expect(
      partitionByOwner(["postgres"], foreign, "rootEntries").orphans,
    ).toEqual([]);
  });

  test("no manifests at all means every candidate is an orphan", () => {
    // The bootstrap state, and the state on a machine with one checkout: the
    // check behaves exactly as it did before manifests existed.
    expect(partitionByOwner(["state/x"], [], "keys").orphans).toEqual([
      "state/x",
    ]);
  });
});

describe("describeAttribution", () => {
  test("names each entry with its owners, both sorted", () => {
    expect(
      describeAttribution(
        new Map([
          ["state/z", ["att-b", "att-a"]],
          ["state/a", ["att-c"]],
        ]),
      ),
    ).toBe("state/a (att-c), state/z (att-a, att-b)");
  });
});
