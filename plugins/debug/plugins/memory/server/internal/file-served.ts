import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/server";
import { memoryFile } from "../../shared/resources";
import { memoryDir, watchMemoryDir } from "./memory-dir";

/** A plain `.md` file name directly in the memory directory. */
function isMemoryFileName(name: string): boolean {
  return (
    name === basename(name) &&
    name.endsWith(".md") &&
    !name.includes("..") &&
    !name.includes("/")
  );
}

async function readMemoryFile({ name }: { name: string }) {
  if (!isMemoryFileName(name)) {
    throw memoryFile.refuse(
      "invalid-name",
      `not a memory file name: ${JSON.stringify(name)}`,
    );
  }
  const dir = await memoryDir();
  try {
    return { content: await readFile(join(dir, name), "utf-8") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    throw memoryFile.refuse("missing", `${name} is not in ${dir}`);
  }
}

/**
 * `notified` by the memory directory's watch, filtered to this one file: an
 * edit, a delete (now `missing`) and a re-create each re-read it. A malformed
 * name watches nothing — the loader refuses it.
 */
export const memoryFileServed = serveValue(memoryFile, {
  source: "external",
  changes: "notified",
  loader: readMemoryFile,
  whileSubscribed: ({ name }, notify) =>
    isMemoryFileName(name)
      ? watchMemoryDir((entry) => entry === name, notify)
      : () => {},
});
