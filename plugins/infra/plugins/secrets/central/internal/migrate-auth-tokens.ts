import { existsSync, readFileSync, renameSync } from "node:fs";
import { decrypt } from "./crypto";
import { legacyAuthBlob, legacyAuthKey } from "./paths";
import { hasLocal, setLocal } from "./store";

export const AUTH_TOKENS_NAMESPACE = "auth-tokens";
export const AUTH_TOKENS_KEY = "blob-v1";

/**
 * One-shot migration: read the legacy `~/.equin/state/auth/tokens.json.enc`
 * blob with its own `.key`, write it into the secrets store under the
 * `auth-tokens` namespace, then rename both legacy files so they're recoverable
 * if something goes wrong. Idempotent (skips on subsequent boots).
 */
export async function migrateLegacyAuthTokens(): Promise<
  "migrated" | "skipped" | "noop"
> {
  const blobPath = legacyAuthBlob();
  const keyFilePath = legacyAuthKey();
  if (!existsSync(blobPath) || !existsSync(keyFilePath)) {
    return "noop";
  }
  if (hasLocal(AUTH_TOKENS_NAMESPACE, AUTH_TOKENS_KEY)) {
    // Already migrated; leave legacy files alone so the operator can clean up
    // or roll back if desired.
    return "skipped";
  }
  const legacyKey = readFileSync(keyFilePath);
  if (legacyKey.length !== 32) {
    throw new Error(
      `[secrets] legacy auth key has wrong length (${legacyKey.length} != 32); skipping migration`,
    );
  }
  const plaintext = decrypt(readFileSync(blobPath), legacyKey).toString("utf8");
  const parsed = JSON.parse(plaintext) as {
    version?: unknown;
    providers?: unknown;
  };
  if (
    parsed.version !== 1 ||
    typeof parsed.providers !== "object" ||
    parsed.providers === null
  ) {
    throw new Error("[secrets] legacy auth blob has unexpected shape");
  }
  await setLocal(AUTH_TOKENS_NAMESPACE, AUTH_TOKENS_KEY, plaintext);
  const ts = Date.now();
  try {
    renameSync(blobPath, `${blobPath}.migrated-${ts}`);
    renameSync(keyFilePath, `${keyFilePath}.migrated-${ts}`);
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch (err) {
    console.warn(
      "[secrets] migration succeeded but failed to rename legacy files:",
      err,
    );
  }
  return "migrated";
}
