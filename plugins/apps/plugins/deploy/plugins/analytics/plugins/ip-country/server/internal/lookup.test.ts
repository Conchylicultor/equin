import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { createIpCountryLookup } from "./lookup";
import { snapshotNeedsRefresh } from "./refresh";
import { buildSnapshot } from "./snapshot";

const dir = mkdtempSync(join(tmpdir(), "ip-country-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function writeSnapshot(path: string, csv: string): Promise<void> {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, await buildSnapshot(csv, 202609));
  renameSync(tmp, path);
}

describe("createIpCountryLookup", () => {
  test("unavailable with no file, found once one is written and reloaded", async () => {
    const path = asAppPath(join(dir, "a.bin"));
    const lookup = createIpCountryLookup(() => path);
    expect(await lookup.lookup("2.1.1.1")).toEqual({ kind: "unavailable" });

    await writeSnapshot(path, "2.0.0.0,2.255.255.255,FR\n");
    // Held in memory until reloaded: no per-lookup disk probe.
    expect(await lookup.lookup("2.1.1.1")).toEqual({ kind: "unavailable" });
    lookup.reload();
    expect(await lookup.lookup("2.1.1.1")).toEqual({
      kind: "found",
      country: "FR",
    });
    expect(await lookup.lookup("10.0.0.1")).toEqual({ kind: "unlisted" });
  });

  test("reload picks up a replaced file", async () => {
    const path = asAppPath(join(dir, "b.bin"));
    await writeSnapshot(path, "2.0.0.0,2.255.255.255,FR\n");
    const lookup = createIpCountryLookup(() => path);
    expect(await lookup.lookup("2.1.1.1")).toEqual({
      kind: "found",
      country: "FR",
    });

    await writeSnapshot(path, "2.0.0.0,2.255.255.255,DE\n");
    expect(await lookup.lookup("2.1.1.1")).toEqual({
      kind: "found",
      country: "FR",
    });
    lookup.reload();
    expect(await lookup.lookup("2.1.1.1")).toEqual({
      kind: "found",
      country: "DE",
    });
  });

  test("a corrupt file throws on every lookup until reloaded", async () => {
    const path = asAppPath(join(dir, "c.bin"));
    writeFileSync(path, "not a snapshot");
    const lookup = createIpCountryLookup(() => path);
    expect(lookup.lookup("2.1.1.1")).rejects.toThrow(/not a readable snapshot/);
    expect(lookup.lookup("2.1.1.1")).rejects.toThrow(/not a readable snapshot/);
    await writeSnapshot(path, "2.0.0.0,2.255.255.255,FR\n");
    lookup.reload();
    expect(await lookup.lookup("2.1.1.1")).toEqual({
      kind: "found",
      country: "FR",
    });
  });
});

describe("snapshotNeedsRefresh", () => {
  test("missing, stale, or another format needs a refresh; a fresh snapshot does not", async () => {
    const path = join(dir, "d.bin");
    const now = new Date();
    expect(await snapshotNeedsRefresh(path, now)).toBe(true);
    await writeSnapshot(path, "2.0.0.0,2.255.255.255,FR\n");
    expect(await snapshotNeedsRefresh(path, now)).toBe(false);
    const eightDaysOn = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(await snapshotNeedsRefresh(path, eightDaysOn)).toBe(true);
    writeFileSync(path, "garbage-garbage-garbage-garbage");
    expect(await snapshotNeedsRefresh(path, now)).toBe(true);
  });
});
