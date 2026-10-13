import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { serveValue } from "@plugins/network/plugins/live/server";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import { BroadcastEntrySchema } from "../../shared/endpoints";
import { broadcastEntries } from "../../shared/resources";
import { broadcastsPath } from "./broadcasts-file";

const EntriesFileSchema = z.array(BroadcastEntrySchema);

async function readEntries() {
  const path = await broadcastsPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { entries: [], path };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw broadcastEntries.refuse(
      "malformed",
      `${path} is not JSON: ${err.message}`,
    );
  }
  const parsed = EntriesFileSchema.safeParse(json);
  if (!parsed.success) {
    throw broadcastEntries.refuse(
      "malformed",
      `${path} is not a list of broadcasts: ${parsed.error.message}`,
    );
  }
  return { entries: parsed.data, path };
}

/**
 * Hear the broadcasts file change for as long as the value is read: a
 * children-scope watch of its folder through the shared dir hub (the file
 * itself may not exist yet; its folder is the CLI plugin's, always there).
 */
async function watchEntries(notify: () => void): Promise<() => void> {
  const path = await broadcastsPath();
  const file = basename(path);
  const release = await acquireDirWatch({
    dir: dirname(path),
    scope: "children",
    onChange: (events) => {
      if (events.some((e) => basename(e.path) === file)) notify();
    },
  });
  // A write between the first load and the watch opening produced no event;
  // one re-read closes that gap.
  notify();
  return release;
}

/**
 * `notified` by the file's own watch: the pane's PUT, a hand edit and a
 * checkout move all land on disk, and the watch hears each of them.
 */
export const broadcastEntriesServed = serveValue(broadcastEntries, {
  source: "external",
  changes: "notified",
  loader: readEntries,
  whileSubscribed: (_params, notify) => watchEntries(notify),
});
