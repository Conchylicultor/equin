import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mount } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { diskDirMount } from "@plugins/infra/plugins/paths/plugins/data-files/machine";
import {
  systemOrigin,
  type WriteOrigin,
} from "@plugins/infra/plugins/request-origin/core";
import { PicksChangeSchema } from "../../core/picks";
import {
  PICKS_DIR_NAME,
  openPicksStore,
  type PicksStore,
} from "../../shared/picks";

// The picks store (`shared/picks.ts`, over a Mount) against a throwaway
// prototypes tree on disk — the desktop's mount, so the lock files and the
// atomic write are the real ones. Nothing here touches
// `~/.equin/apps/prototypes`.

const ID = "proto-1789000000-abcd";
const writer = systemOrigin("picks test");

let root: string;
let mount: Mount;
let store: PicksStore;
/** The absolute path of the record file. */
let fileOf: (id: string) => string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prototype-picks-"));
  mount = diskDirMount(root);
  store = openPicksStore(mount);
  fileOf = (id) => join(root, store.fileOf(id));
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
    expect(existsSync(fileOf(ID))).toBe(false);
  });

  test("the file lives under _picks/, named by the id", () => {
    expect(String(store.fileOf(ID))).toBe(`${PICKS_DIR_NAME}/${ID}.json`);
  });

  test("set adds or replaces one option and keeps the others", async () => {
    await store.write(
      ID,
      { kind: "set", option: "palette", value: "azure" },
      writer,
    );
    await store.write(
      ID,
      { kind: "set", option: "density", value: "compact" },
      writer,
    );
    const after = await store.write(
      ID,
      { kind: "set", option: "palette", value: "violet" },
      writer,
    );
    expect(after).toEqual({ palette: "violet", density: "compact" });
    expect(await store.read(ID)).toEqual({
      palette: "violet",
      density: "compact",
    });
    // Readable by a person, and nothing left behind by the atomic write.
    expect(JSON.parse(await readFile(fileOf(ID), "utf8"))).toEqual({
      palette: "violet",
      density: "compact",
    });
    expect(await readdir(join(root, PICKS_DIR_NAME))).toEqual([
      `${ID}.json`,
      `${ID}.lock`,
    ]);
  });

  test("reset removes the file", async () => {
    await store.write(
      ID,
      { kind: "set", option: "palette", value: "azure" },
      writer,
    );
    expect(await store.write(ID, { kind: "reset" }, writer)).toEqual({});
    expect(existsSync(fileOf(ID))).toBe(false);
    expect(await store.read(ID)).toEqual({});
  });

  test("every real write names its writer to the mount, and a no-op writes nothing", async () => {
    const calls: string[] = [];
    const recording: Mount = {
      ...mount,
      write: (path, data, opts) => {
        calls.push(`write ${path} ${opts.writer.kind}`);
        return mount.write(path, data, opts);
      },
      remove: (path, opts) => {
        calls.push(`remove ${path} ${opts.writer.kind}`);
        return mount.remove(path, opts);
      },
    };
    const agent: WriteOrigin = { kind: "agent", source: "e2e" };
    const s = openPicksStore(recording);
    const pick = { kind: "set", option: "palette", value: "azure" } as const;
    await s.write(ID, pick, agent);
    // The same pick again, and a reset twice: only the first reset writes.
    await s.write(ID, pick, agent);
    await s.write(ID, { kind: "reset" }, agent);
    await s.write(ID, { kind: "reset" }, agent);
    expect(calls).toEqual([
      `write _picks/${ID}.json agent`,
      `remove _picks/${ID}.json agent`,
    ]);
  });

  test("a malformed file throws — never read as nothing picked", async () => {
    await mkdir(join(root, PICKS_DIR_NAME), { recursive: true });

    await writeFile(fileOf(ID), "{ not json");
    expect((await rejection(store.read(ID))).message).toContain(
      "malformed prototype picks file",
    );
    // …and a write does not paper over it.
    expect(
      (
        await rejection(
          store.write(
            ID,
            { kind: "set", option: "palette", value: "azure" },
            writer,
          ),
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
      await writeFile(fileOf(ID), bad);
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
