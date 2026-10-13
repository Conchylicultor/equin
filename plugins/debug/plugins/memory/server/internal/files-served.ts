import { readdir } from "node:fs/promises";
import { serveValue } from "@plugins/network/plugins/live/server";
import { memoryFiles, type MemoryFile } from "../../shared/resources";
import { memoryDir, watchMemoryDir } from "./memory-dir";

function typeFor(name: string): MemoryFile["type"] {
  if (name === "MEMORY.md") return "index";
  if (name.startsWith("feedback_")) return "feedback";
  if (name.startsWith("project_")) return "project";
  if (name.startsWith("user_")) return "user";
  if (name.startsWith("reference_")) return "reference";
  return "other";
}

async function listFiles() {
  const dir = await memoryDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { files: [], dir };
  }
  const files: MemoryFile[] = names
    .filter((n) => n.endsWith(".md"))
    .sort((a, b) => {
      // MEMORY.md first, then alphabetical
      if (a === "MEMORY.md") return -1;
      if (b === "MEMORY.md") return 1;
      return a.localeCompare(b);
    })
    .map((name) => ({ name, type: typeFor(name) }));
  return { files, dir };
}

/**
 * `notified` by the memory directory's watch: a file added, removed or
 * renamed there moves the listing. Only `.md` entries are listed, so only
 * they notify.
 */
export const memoryFilesServed = serveValue(memoryFiles, {
  source: "external",
  changes: "notified",
  loader: listFiles,
  whileSubscribed: (_params, notify) =>
    watchMemoryDir((name) => name.endsWith(".md"), notify),
});
