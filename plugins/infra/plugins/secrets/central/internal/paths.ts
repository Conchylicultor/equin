// The two directories this plugin owns under the data root, declared in
// `data-dirs/index.ts`, plus the file names inside them. One module so every
// reader here names a file the same way and no second spelling can appear.
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { legacyAuthDir, secretsDir } from "../../data-dirs";

export { legacyAuthDir, secretsDir };

/** The AES-256-GCM secrets blob. */
export function storePath(): AppPath {
  return secretsDir.file("secrets.json.enc");
}

/** The fallback master key, used when the OS keychain is unavailable. */
export function keyPath(): AppPath {
  return secretsDir.file(".key");
}

/** The legacy auth blob, read once by the one-shot migration. */
export function legacyAuthBlob(): AppPath {
  return legacyAuthDir.file("tokens.json.enc");
}

/** The legacy auth blob's own key. */
export function legacyAuthKey(): AppPath {
  return legacyAuthDir.file(".key");
}
