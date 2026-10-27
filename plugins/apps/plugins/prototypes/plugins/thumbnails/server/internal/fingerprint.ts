import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import { relPath } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { fingerprintFolder, type FolderFingerprint } from "./hash-dir";

/** The content fingerprint of one prototype folder — the thumbnail cache key. */
export function fingerprintPrototype(name: string): Promise<FolderFingerprint> {
  return fingerprintFolder(prototypesFiles, relPath(name));
}
