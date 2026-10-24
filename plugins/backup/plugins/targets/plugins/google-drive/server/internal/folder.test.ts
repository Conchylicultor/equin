import { describe, expect, test } from "bun:test";
import {
  LEGACY_PRODUCT_NAMES,
  PRODUCT_NAME,
} from "@plugins/framework/plugins/product-name/core";
import { resolveFolder, type DriveFolders } from "./folder";

const CURRENT = `${PRODUCT_NAME} Backups`;
const LEGACY = `${LEGACY_PRODUCT_NAMES[0]} Backups`;

/** An in-memory Drive holding folders by name, recording every write. */
function fakeDrive(folders: Record<string, string>) {
  const calls: string[] = [];
  const drive: DriveFolders = {
    find: async (name) => folders[name] ?? null,
    rename: async (id, name) => {
      calls.push(`rename ${id} → ${name}`);
    },
    create: async (name) => {
      calls.push(`create ${name}`);
      return "new-id";
    },
  };
  return { drive, calls };
}

describe("resolveFolder", () => {
  test("uses the current-named folder as is", async () => {
    const { drive, calls } = fakeDrive({ [CURRENT]: "cur", [LEGACY]: "old" });
    expect(await resolveFolder(drive)).toBe("cur");
    expect(calls).toEqual([]);
  });

  test("renames a legacy-named folder in place, keeping its backups", async () => {
    const { drive, calls } = fakeDrive({ [LEGACY]: "old" });
    expect(await resolveFolder(drive)).toBe("old");
    expect(calls).toEqual([`rename old → ${CURRENT}`]);
  });

  test("creates the folder when neither exists", async () => {
    const { drive, calls } = fakeDrive({});
    expect(await resolveFolder(drive)).toBe("new-id");
    expect(calls).toEqual([`create ${CURRENT}`]);
  });
});
