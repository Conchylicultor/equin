import type { ConfigFileContent, ConfigProxy } from "../internal/config-proxy";
import type { ConfigFileRef } from "../internal/store";

/**
 * Config files held in a map, each behind a synchronous read / write / exists
 * proxy — what `propagate` and `propagateGitLayerDocument` write through. The
 * stores themselves are asynchronous (`ConfigStoreImpl`), so a suite driving
 * the synchronous tier logic directly uses this instead.
 */
export function proxyFiles(): (ref: ConfigFileRef) => ConfigProxy {
  const files = new Map<string, ConfigFileContent>();
  const keyOf = (ref: ConfigFileRef) =>
    `${ref.storePath}\0${ref.scopeId ?? ""}\0${ref.file}`;
  return (ref) => {
    const key = keyOf(ref);
    return {
      read: () => files.get(key) ?? null,
      write: (content, hash) => {
        files.set(key, { content, hash });
      },
      exists: () => files.has(key),
    };
  };
}
