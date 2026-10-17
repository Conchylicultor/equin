import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { keyPath, secretsDir, storePath } from "./paths";
import { SecretsKeychainLockedError } from "@plugins/infra/plugins/secrets/core";

const KEYCHAIN_SERVICE = "singularity";
const KEYCHAIN_ACCOUNT = "secrets-aes-256-gcm-v1";

let cached: Buffer | null = null;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import, library may be absent.
let keychainModule: any | null | undefined;
let keychainWarned = false;

// biome-ignore lint/suspicious/noExplicitAny: keyring native module has runtime-only shape.
async function loadKeychainModule(): Promise<any | null> {
  if (keychainModule !== undefined) return keychainModule;
  try {
    keychainModule = await import("@napi-rs/keyring");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND")
      throw err;
    keychainModule = null;
  }
  return keychainModule;
}

/**
 * Where the master key lives on this OS.
 *
 * Linux: the FILE, by design rather than as a fallback. `@napi-rs/keyring`'s
 * Linux backends are the Secret Service (a desktop session's gnome-keyring /
 * kwallet — absent, or locked, on a headless server nobody is logged into) and
 * the kernel keyring (gone at every reboot). Either would hand the store a key
 * that differs between boots, and a differing key is every connected token
 * lost. The file (0600, in a 0700 dir under the user's own data root) is the
 * same trust boundary as the rest of the user's data.
 */
function keySource(): "keychain" | "file" {
  return process.platform === "linux" ? "file" : "keychain";
}

/**
 * A new key, unless a blob already exists: that blob was encrypted with a key
 * this process could not find, and a fresh one could never decrypt it — it
 * would only make the next write replace every secret with an empty store.
 * Throwing keeps the blob, and the missing key's source, for a human to fix.
 */
function mintKey(where: string): Buffer {
  if (existsSync(storePath())) {
    throw new SecretsKeychainLockedError(
      `no master key in ${where}, but ${storePath()} exists — it was encrypted with a key this host cannot find; refusing to mint a new one over it`,
    );
  }
  return randomBytes(32);
}

function readKeyFile(): Buffer | null {
  const path = keyPath();
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  if (buf.length !== 32) {
    throw new Error(
      `secrets key file ${path} has wrong length (${buf.length} != 32)`,
    );
  }
  return buf;
}

function readOrCreateKeyFile(): Buffer {
  try {
    // Not `secretsDir.ensure()`: the mode is load-bearing here — this
    // directory holds the master key, so it must be 0700 (owner-only), and
    // `ensure()` creates with the process umask.
    if (!existsSync(secretsDir.path)) {
      mkdirSync(secretsDir.path, { mode: 0o700, recursive: true });
    }
    const existing = readKeyFile();
    if (existing) return existing;
    const fresh = mintKey(keyPath());
    writeFileSync(keyPath(), fresh, { mode: 0o600 });
    chmodSync(keyPath(), 0o600);
    return fresh;
  } catch (err) {
    if (err instanceof SecretsKeychainLockedError) throw err;
    throw new SecretsKeychainLockedError(
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Resolve the 32-byte AES-256 key used to encrypt the secrets blob.
 *
 * macOS / Windows: the OS keychain via `@napi-rs/keyring`, cached in-memory
 * after first read so the OS only prompts once per process lifetime. Fallback:
 * `~/.singularity/state/secrets/.key` (mode 0600), when the native module is
 * unavailable (CI) or fails at runtime. Linux: that file only (`keySource`).
 *
 * The key a blob was written with is the only one that reads it, so the source
 * is sticky: a keychain with no entry defers to a `.key` an earlier fallback
 * wrote, and no path mints a key while a blob exists (`mintKey`).
 */
export async function getEncryptionKey(): Promise<Buffer> {
  if (cached) return cached;

  if (keySource() === "file") {
    cached = readOrCreateKeyFile();
    return cached;
  }

  const mod = await loadKeychainModule();
  if (mod) {
    try {
      const entry = new mod.Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      const existing = entry.getPassword() as string | null;
      if (existing) {
        const buf = Buffer.from(existing, "base64");
        if (buf.length !== 32) {
          throw new Error(
            `secrets keychain key has wrong length (${buf.length} != 32)`,
          );
        }
        cached = buf;
        return cached;
      }
      // An earlier boot fell back to the file: that key wrote the blob.
      const fromFile = readKeyFile();
      if (fromFile) {
        cached = fromFile;
        return cached;
      }
      const fresh = mintKey("the OS keychain");
      entry.setPassword(fresh.toString("base64"));
      cached = fresh;
      return cached;
    } catch (err) {
      // `mintKey`'s refusal is about the blob, not the keychain: no fallback.
      if (err instanceof SecretsKeychainLockedError) throw err;
      if (!keychainWarned) {
        keychainWarned = true;
        console.warn(
          "[secrets] keychain unavailable, falling back to file:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  cached = readOrCreateKeyFile();
  return cached;
}

export function isKeychainCached(): boolean {
  return cached !== null;
}
