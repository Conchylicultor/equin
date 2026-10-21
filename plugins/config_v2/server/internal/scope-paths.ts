import type {
  ConfigDocRef,
  ConfigDocumentFile,
  ConfigFileRef,
} from "../../core";

// Canonical base-scope key. "" means "no scope" — base/global config that lives
// exactly where it does today (no extra path segment).
export const BASE_SCOPE = "";

/**
 * The three files of one document, as the refs the user-layer store
 * (`ConfigStore`) addresses them by. `scopeId` "" or undefined is the base
 * document. Shared by every reader and writer, so a computation and the
 * fingerprint it is memoized on can never name different files.
 */
export function documentFiles(
  doc: ConfigDocRef,
): Record<ConfigDocumentFile, ConfigFileRef> {
  const scoped = doc.scopeId ? { scopeId: doc.scopeId } : {};
  const ref = (file: ConfigDocumentFile): ConfigFileRef => ({
    storePath: doc.storePath,
    ...scoped,
    file,
  });
  return {
    origin: ref("origin"),
    override: ref("override"),
    ancestor: ref("ancestor"),
  };
}
