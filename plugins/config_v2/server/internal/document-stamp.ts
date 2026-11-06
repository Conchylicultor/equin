import type { ConfigDocumentFile, ConfigFileRef } from "../../core";
import { ConfigStore } from "./host-services";

/**
 * The identity of a document's whole file trio as it is now: the store's
 * stamp of each file (on the desktop its inode, mtime-ns and size — a stat,
 * no read), so an unchanged stamp is an unchanged trio. What a reader of the
 * trio is memoized on (the conflict memo), and what tells the registry a
 * refresh found nothing new (a watcher event for the write it already
 * refreshed itself, a touch that rewrote nothing).
 */
export async function documentStamp(
  files: Record<ConfigDocumentFile, ConfigFileRef>,
): Promise<string> {
  const store = ConfigStore.get();
  const stamps = await Promise.all([
    store.stamp(files.origin),
    store.stamp(files.override),
    store.stamp(files.ancestor),
  ]);
  return stamps.join("|");
}
