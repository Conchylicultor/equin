import { describe, expect, test } from "bun:test";
import {
  computeOrphans,
  declaredTablesFromSnapshot,
  pendingMigrationFiles,
} from "./orphaned-tables";

const ALLOWLIST = ["__ledger_table", "derived_view_state"] as const;

describe("declaredTablesFromSnapshot", () => {
  test("extracts the bare `name` of each public table", () => {
    const snapshot = {
      tables: {
        "public.foo": { name: "foo" },
        "public.bar": { name: "bar" },
      },
    };
    expect(declaredTablesFromSnapshot(snapshot)).toEqual(new Set(["foo", "bar"]));
  });

  test("throws when `tables` is missing", () => {
    expect(() => declaredTablesFromSnapshot({})).toThrow();
  });

  test("throws when `tables` is empty (would otherwise flag everything)", () => {
    expect(() => declaredTablesFromSnapshot({ tables: {} })).toThrow();
  });
});

describe("computeOrphans", () => {
  test("flags a live table that is neither declared nor allowlisted", () => {
    const live = ["foo", "bar", "__ledger_table", "zombie"];
    const declared = new Set(["foo", "bar"]);
    expect(computeOrphans(live, declared, ALLOWLIST)).toEqual(["zombie"]);
  });

  test("no orphans when live ⊆ declared ∪ allowlist", () => {
    const live = ["foo", "bar", "__ledger_table", "derived_view_state"];
    const declared = new Set(["foo", "bar"]);
    expect(computeOrphans(live, declared, ALLOWLIST)).toEqual([]);
  });

  test("allowlist members are never flagged even if undeclared", () => {
    const live = ["__ledger_table", "derived_view_state"];
    const declared = new Set<string>();
    expect(computeOrphans(live, declared, ALLOWLIST)).toEqual([]);
  });

  test("result is sorted", () => {
    const live = ["zeta", "alpha", "mike"];
    const declared = new Set<string>();
    expect(computeOrphans(live, declared, ALLOWLIST)).toEqual(["alpha", "mike", "zeta"]);
  });
});

describe("pendingMigrationFiles", () => {
  const APPLIED = "20260730_135017_2b030391__add_deploy_deployments.sql";
  const DROP = "20260801_152825_266d6b7e__remove_config_v2_staging.sql";

  test("a migration whose sha8 is absent from the ledger is pending", () => {
    expect(pendingMigrationFiles([APPLIED, DROP], new Set(["2b030391"]))).toEqual([DROP]);
  });

  test("nothing pending once every sha8 is in the ledger", () => {
    expect(pendingMigrationFiles([APPLIED, DROP], new Set(["2b030391", "266d6b7e"]))).toEqual(
      [],
    );
  });

  test("an empty ledger (never-migrated DB) leaves the whole chain pending", () => {
    expect(pendingMigrationFiles([APPLIED, DROP], new Set())).toEqual([APPLIED, DROP]);
  });

  test("non-migration filenames (meta/, README) are ignored", () => {
    expect(pendingMigrationFiles(["meta", "README.md", "notes.sql"], new Set())).toEqual([]);
  });

  test("result is sorted (timestamp order)", () => {
    expect(pendingMigrationFiles([DROP, APPLIED], new Set())).toEqual([APPLIED, DROP]);
  });
});
