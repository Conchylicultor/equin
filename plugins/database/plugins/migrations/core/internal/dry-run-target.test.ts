import { describe, expect, test } from "bun:test";
import {
  dryRunTarget,
  isMigrationShadowOf,
  migrationShadowName,
  parseMigrationShadowName,
} from "./dry-run-target";

describe("migration shadow names", () => {
  const name = migrationShadowName("main_db", "abc123@2026-11-15");

  test("are deterministic, internal-grammar and within Postgres's 63 bytes", () => {
    expect(migrationShadowName("main_db", "abc123@2026-11-15")).toBe(name);
    expect(name).toMatch(/^[a-z0-9][a-z0-9_]{0,62}$/);
  });

  test("change with the migration tree and with the day", () => {
    expect(migrationShadowName("main_db", "def456@2026-11-15")).not.toBe(name);
    expect(migrationShadowName("main_db", "abc123@2026-11-16")).not.toBe(name);
  });

  test("name the main they belong to", () => {
    expect(isMigrationShadowOf(name, "main_db")).toBe(true);
    expect(isMigrationShadowOf(name, "other")).toBe(false);
    expect(isMigrationShadowOf("main_db", "main_db")).toBe(false);
  });

  test("a lookalike carrying the suffix is refused", () => {
    expect(() => parseMigrationShadowName("x__migshadow")).toThrow(
      /provenance/,
    );
  });
});

describe("dryRunTarget", () => {
  test("accepts a shadow", () => {
    const shadow = migrationShadowName("main_db", "abc123@2026-11-15");
    expect(dryRunTarget(shadow).database).toBe(shadow);
  });

  test("refuses every other database — main's, a worktree's, a test DB", () => {
    expect(() => dryRunTarget("main_db")).toThrow(/may not run/);
    expect(() => dryRunTarget("att-1794713754-tmwvjy")).toThrow(/may not run/);
    expect(() => dryRunTarget("mig_check_1_a__testdb")).toThrow(/may not run/);
  });
});
