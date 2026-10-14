import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";
import { declareGrowthBound, getGrowthBounds } from "./growth-bounds";

const TEST_CONSUMER = { kind: "internal", note: "test" } as const;

// The registry is process-global, so every test uses a UNIQUE name to avoid
// cross-test collisions (a sink is declared exactly once). Keys are namespaced:
// a DB table is `table:${name}`, a file sink is `file:${id}`.

describe("declareGrowthBound / getGrowthBounds", () => {
  test("a ttl bound and a cascade bound coexist under table: keys", () => {
    declareGrowthBound("gb_ttl_table", { kind: "ttl", ttlDays: 7 });
    declareGrowthBound("gb_cascade_table", {
      kind: "cascade",
      owner: "gb_owner",
    });

    const bounds = getGrowthBounds();
    expect(bounds.get("table:gb_ttl_table")).toEqual({
      kind: "ttl",
      ttlDays: 7,
    });
    expect(bounds.get("table:gb_cascade_table")).toEqual({
      kind: "cascade",
      owner: "gb_owner",
    });
  });

  test("a conflicting re-declaration of the same table throws", () => {
    declareGrowthBound("gb_conflict", { kind: "ttl", ttlDays: 7 });
    expect(() =>
      declareGrowthBound("gb_conflict", { kind: "cascade", owner: "x" }),
    ).toThrow(/already has a growth bound/);
  });

  test("an identical re-declaration of the same table also throws", () => {
    declareGrowthBound("gb_identical", { kind: "ttl", ttlDays: 3 });
    expect(() =>
      declareGrowthBound("gb_identical", { kind: "ttl", ttlDays: 3 }),
    ).toThrow(/already has a growth bound/);
  });

  test("getGrowthBounds returns a copy, not the live map", () => {
    declareGrowthBound("gb_copy", { kind: "ttl", ttlDays: 1 });
    const first = getGrowthBounds() as Map<string, unknown>;
    first.delete("table:gb_copy");
    first.set("table:gb_intruder", { kind: "ttl", ttlDays: 99 });

    const second = getGrowthBounds();
    expect(second.get("table:gb_copy")).toEqual({ kind: "ttl", ttlDays: 1 });
    expect(second.has("table:gb_intruder")).toBe(false);
  });

  test("a registered file sink is merged in as a rotate bound under file:", () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-file-"));
    const id = `gb_file_${process.pid}`;
    const sink = defineFileSink({
      id,
      description: "test file sink",
      consumer: TEST_CONSUMER,
      path: join(dir, "x.jsonl"),
      maxBytes: 1234,
      keep: 2,
    });

    const bounds = getGrowthBounds();
    expect(bounds.get(`file:${id}`)).toEqual(sink.bound);
    expect(bounds.get(`file:${id}`)).toEqual({
      kind: "rotate",
      maxBytes: 1234,
      keep: 2,
    });
  });

  test("a table and a file with the same bare name do not collide", () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-collide-"));
    const shared = `gb_shared_${process.pid}`;
    declareGrowthBound(shared, { kind: "ttl", ttlDays: 5 });
    defineFileSink({
      id: shared,
      description: "t",
      consumer: TEST_CONSUMER,
      path: join(dir, "s.jsonl"),
    });

    const bounds = getGrowthBounds();
    expect(bounds.get(`table:${shared}`)).toEqual({ kind: "ttl", ttlDays: 5 });
    expect(bounds.get(`file:${shared}`)?.kind).toBe("rotate");
  });
});
