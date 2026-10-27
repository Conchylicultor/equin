import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PicksChangeSchema } from "../core/picks";
import { PICKS_DIR_NAME, openPicksStore, type PicksStore } from "./picks";

// The picks store against a throwaway prototypes tree. The store takes its root
// as an argument, so nothing here touches `~/.equin/apps/prototypes`.

const ID = "proto-1789000000-abcd";

let root: string;
let store: PicksStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prototype-picks-"));
  store = openPicksStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Await `p` and return the Error it rejected with; throw if it resolved (the
 * history store suite's helper — `expect(p).rejects` is typed `void` here).
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error("expected a rejection, but it resolved");
}

describe("openPicksStore", () => {
  test("nothing picked is an empty record, and no file", async () => {
    expect(await store.read(ID)).toEqual({});
    expect(existsSync(store.fileOf(ID))).toBe(false);
  });

  test("the file lives under _picks/, named by the id", () => {
    expect(store.fileOf(ID)).toBe(join(root, PICKS_DIR_NAME, `${ID}.json`));
  });

  test("set adds or replaces one option and keeps the others", async () => {
    await store.write(ID, { kind: "set", option: "palette", value: "azure" });
    await store.write(ID, { kind: "set", option: "density", value: "compact" });
    const after = await store.write(ID, {
      kind: "set",
      option: "palette",
      value: "violet",
    });
    expect(after).toEqual({ palette: "violet", density: "compact" });
    expect(await store.read(ID)).toEqual({
      palette: "violet",
      density: "compact",
    });
    // Readable by a person, and nothing left behind by the atomic write.
    expect(JSON.parse(await readFile(store.fileOf(ID), "utf8"))).toEqual({
      palette: "violet",
      density: "compact",
    });
    expect(existsSync(`${store.fileOf(ID)}.tmp`)).toBe(false);
  });

  test("reset removes the file", async () => {
    await store.write(ID, { kind: "set", option: "palette", value: "azure" });
    expect(await store.write(ID, { kind: "reset" })).toEqual({});
    expect(existsSync(store.fileOf(ID))).toBe(false);
    expect(await store.read(ID)).toEqual({});
  });

  test("the hooks run around a real write, and not for a no-op", async () => {
    const calls: string[] = [];
    const hooks = {
      beforeWrite: () => calls.push(`before:${existsSync(store.fileOf(ID))}`),
      afterWrite: () => calls.push(`after:${existsSync(store.fileOf(ID))}`),
    };
    await store.write(
      ID,
      { kind: "set", option: "palette", value: "azure" },
      hooks,
    );
    expect(calls).toEqual(["before:false", "after:true"]);

    // The same pick again, and a reset of nothing: no write, so no hooks.
    calls.length = 0;
    await store.write(
      ID,
      { kind: "set", option: "palette", value: "azure" },
      hooks,
    );
    await store.write(ID, { kind: "reset" }, hooks);
    await store.write(ID, { kind: "reset" }, hooks);
    expect(calls).toEqual(["before:true", "after:false"]);
  });

  test("restore puts back exact bytes, or no file", async () => {
    await store.write(ID, { kind: "set", option: "palette", value: "azure" });
    await store.restore(ID, { present: true, bytes: '{"palette":"indigo"}' });
    expect(await readFile(store.fileOf(ID), "utf8")).toBe(
      '{"palette":"indigo"}',
    );
    await store.restore(ID, { present: false });
    expect(existsSync(store.fileOf(ID))).toBe(false);
    // Restoring "no file" when there is none is fine too.
    await store.restore(ID, { present: false });
  });

  test("a malformed file throws — never read as nothing picked", async () => {
    await mkdir(join(root, PICKS_DIR_NAME), { recursive: true });

    await writeFile(store.fileOf(ID), "{ not json");
    expect((await rejection(store.read(ID))).message).toContain(
      "malformed prototype picks file",
    );
    // …and a write does not paper over it.
    expect(
      (
        await rejection(
          store.write(ID, { kind: "set", option: "palette", value: "azure" }),
        )
      ).message,
    ).toContain("malformed prototype picks file");

    for (const bad of [
      '["azure"]',
      '{"palette": 3}',
      '{"Palette": "azure"}',
      '{"v": "azure"}',
      '{"palette": "Soft tray"}',
    ]) {
      await writeFile(store.fileOf(ID), bad);
      expect((await rejection(store.read(ID))).message).toContain(
        "malformed prototype picks file",
      );
    }
  });

  test("a name that is not an id never becomes a path", async () => {
    expect(() => store.fileOf("../etc")).toThrow("not a prototype id");
    expect((await rejection(store.read("_template"))).message).toContain(
      "not a prototype id",
    );
  });
});

describe("PicksChangeSchema", () => {
  test("a change is judged by the option grammar, v reserved", () => {
    expect(
      PicksChangeSchema.safeParse({
        kind: "set",
        option: "palette",
        value: "3-octaves",
      }).success,
    ).toBe(true);
    expect(PicksChangeSchema.safeParse({ kind: "reset" }).success).toBe(true);
    // A color option's custom pick: lowercase #rrggbb only.
    expect(
      PicksChangeSchema.safeParse({
        kind: "set",
        option: "accent",
        value: "#3b82f6",
      }).success,
    ).toBe(true);
    for (const bad of [
      { kind: "set", option: "accent", value: "#3B82F6" },
      { kind: "set", option: "accent", value: "#3b82f6ff" },
      { kind: "set", option: "accent", value: "oklch(0.6 0.2 260)" },
      { kind: "set", option: "v", value: "azure" },
      { kind: "set", option: "Palette", value: "azure" },
      { kind: "set", option: "palette", value: "Soft tray" },
      { kind: "set", option: "palette" },
      { kind: "clear" },
    ]) {
      expect(PicksChangeSchema.safeParse(bad).success).toBe(false);
    }
  });
});
