import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { auditUserConfigOrphans } from "./orphan-audit";

// Only the storePath (first tuple element) is read by the audit; the descriptor
// object is never dereferenced, so a bare cast is enough for a fake live set.
function live(storePath: string): [string, ConfigDescriptor] {
  return [storePath, {} as ConfigDescriptor];
}

const HASH = "// @hash abc123def456\n";

describe("auditUserConfigOrphans", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "config-orphan-audit-"));
    const seed = (relPath: string) => {
      const full = join(dir, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, `${HASH}{}\n`);
    };

    // Orphan: origin-only → noise / removed.
    seed("noise-hier/lonely.origin.jsonc");
    // Orphan: base override (+origin) → stranded-data / removed.
    seed("data-hier/stranded.origin.jsonc");
    seed("data-hier/stranded.jsonc");
    // Orphan: @app scoped override → stranded-data / removed.
    seed("scoped-hier/@app/myapp/scoped.jsonc");
    // Orphan: ancestor-only → noise / removed.
    seed("anc-hier/leftover.ancestor.jsonc");
    // Orphan: origin whose name lives at a DIFFERENT live hier → noise / relocated.
    seed("old-hier/moved.origin.jsonc");
    // NOT an orphan: its (hier,name) is in the injected live set → must be excluded.
    seed("live-hier/present.jsonc");
    seed("live-hier/present.origin.jsonc");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const descriptors: [string, ConfigDescriptor][] = [
    live("live-hier/present.jsonc"),
    live("new-hier/moved.jsonc"), // same name "moved", different hier → relocated target
  ];

  test("classifies every orphan and excludes the live file", async () => {
    const { orphans } = await auditUserConfigOrphans(dir, descriptors);
    const byKey = new Map(orphans.map((o) => [o.storeKey, o]));

    // The live descriptor's files never surface.
    expect(byKey.has("live-hier/present")).toBe(false);
    expect(orphans).toHaveLength(5);

    // noise / removed — a stale default snapshot, zero user data.
    expect(byKey.get("noise-hier/lonely")).toMatchObject({
      riskClass: "noise",
      reason: "removed",
    });
    expect(byKey.get("noise-hier/lonely")!.files.map((f) => f.role)).toEqual([
      "origin",
    ]);
    expect(byKey.get("noise-hier/lonely")!.relocatedToHier).toBeUndefined();

    // stranded-data / removed — a real base override.
    const stranded = byKey.get("data-hier/stranded")!;
    expect(stranded.riskClass).toBe("stranded-data");
    expect(stranded.reason).toBe("removed");
    expect(new Set(stranded.files.map((f) => f.role))).toEqual(
      new Set(["origin", "override"]),
    );

    // stranded-data / removed — a scoped override (@app strips to the base key).
    const scoped = byKey.get("scoped-hier/scoped")!;
    expect(scoped.riskClass).toBe("stranded-data");
    expect(scoped.reason).toBe("removed");
    expect(scoped.files.map((f) => f.role)).toEqual(["scoped-override"]);

    // noise / removed — an orphaned ancestor snapshot.
    const anc = byKey.get("anc-hier/leftover")!;
    expect(anc.riskClass).toBe("noise");
    expect(anc.files.map((f) => f.role)).toEqual(["ancestor"]);

    // noise / relocated — same name lives at a different hierarchy now.
    const moved = byKey.get("old-hier/moved")!;
    expect(moved.riskClass).toBe("noise");
    expect(moved.reason).toBe("relocated");
    expect(moved.relocatedToHier).toBe("new-hier");
  });

  test("data-bearing orphans sort ahead of noise, deterministically", async () => {
    const { orphans } = await auditUserConfigOrphans(dir, descriptors);
    const stranded = orphans.filter((o) => o.riskClass === "stranded-data");
    // Both stranded entries come before the first noise entry.
    const firstNoiseIdx = orphans.findIndex((o) => o.riskClass === "noise");
    expect(firstNoiseIdx).toBe(stranded.length);
  });

  test("a missing config dir yields no orphans", async () => {
    expect(
      await auditUserConfigOrphans(join(dir, "does-not-exist"), descriptors),
    ).toEqual({
      orphans: [],
    });
  });
});
