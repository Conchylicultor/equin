import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import { relPath } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { persistedFingerprintMemo } from "./fingerprint-memo";
import { fingerprintFolder, type FolderFingerprint } from "./hash-dir";
import { thumbnailCache } from "./roots";

/**
 * The prototypes' fingerprint memo, host-global in the thumbnail cache — so an
 * unchanged folder is not re-read and re-hashed on every backend's boot.
 */
export const prototypeFingerprints = persistedFingerprintMemo(thumbnailCache);

/** The content fingerprint of one prototype folder — the thumbnail cache key. */
export async function fingerprintPrototype(
  name: string,
): Promise<FolderFingerprint> {
  return fingerprintFolder(
    prototypesFiles,
    relPath(name),
    await prototypeFingerprints.load(),
  );
}
