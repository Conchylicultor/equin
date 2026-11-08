import { exists, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { rename, writeFile, chmod, unlink, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { decrypt, encrypt } from "./crypto";
import { getEncryptionKey } from "./key-store";
import { secretsDir, storePath } from "./paths";
import type { SecretMetadata } from "@plugins/infra/plugins/secrets/core";
import {
  applyWrite,
  emptyBlob,
  listKeys,
  metadataOf,
  readValue,
  upgradeBlob,
  type Access,
  type StoreBlob,
} from "./layers";

export type { Access } from "./layers";

let cached: StoreBlob | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

async function loadFromDisk(): Promise<StoreBlob> {
  const store = storePath();
  if (!(await exists(store))) return emptyBlob();
  const key = await getEncryptionKey();
  const blob = await readFile(store);
  const decrypted = decrypt(blob, key);
  // An older version upgrades in memory; the next write persists it.
  return upgradeBlob(JSON.parse(decrypted.toString("utf8")));
}

export async function initStore(): Promise<void> {
  // Not `secretsDir.ensure()`: the mode is load-bearing here. This directory
  // holds the fallback master key, so it must be 0700 — owner-only — and
  // `ensure()` creates with the process umask.
  if (!(await exists(secretsDir.path))) {
    await mkdir(secretsDir.path, { mode: 0o700, recursive: true });
  }
  await getEncryptionKey();
  cached = await loadFromDisk();
}

function ensureLoaded(): StoreBlob {
  if (!cached) {
    throw new Error(
      "secrets: store not initialized; secrets.onReady must run before any API call",
    );
  }
  return cached;
}

async function persist(blob: StoreBlob): Promise<void> {
  const key = await getEncryptionKey();
  const json = Buffer.from(JSON.stringify(blob), "utf8");
  const encrypted = encrypt(json, key);
  const store = storePath();
  const tmpPath = `${store}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmpPath, encrypted, { mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, store);
  } catch (err) {
    try {
      await unlink(tmpPath);
      // eslint-disable-next-line promise-safety/no-bare-catch
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  // eslint-disable-next-line promise-safety/no-absorbed-failure -- chain-tail catch only keeps the retained `writeChain` from becoming an unhandled rejection; the real error still propagates to the caller via the returned `next`
  writeChain = next.catch(() => undefined);
  return next;
}

export function getLocal(
  access: Access,
  namespace: string,
  key: string,
): string | undefined {
  return readValue(ensureLoaded(), access, namespace, key);
}

export function hasLocal(
  access: Access,
  namespace: string,
  key: string,
): boolean {
  return getLocal(access, namespace, key) !== undefined;
}

export function getMetadataLocal(
  access: Access,
  namespace: string,
  key: string,
): SecretMetadata {
  return metadataOf(ensureLoaded(), access, namespace, key);
}

export function listKeysLocal(access: Access, namespace: string): string[] {
  return listKeys(ensureLoaded(), access, namespace);
}

/** Set (`value`) or delete (`null`) in the caller's layer; persisted only when something changed. */
function writeLocal(
  access: Access,
  namespace: string,
  key: string,
  value: string | null,
): Promise<void> {
  return enqueueWrite(async () => {
    // Applied to a copy, which becomes the store only once it is on disk: a
    // failed persist (keychain locked, disk full) leaves memory as the file is.
    const next = structuredClone(ensureLoaded());
    if (applyWrite(next, access, namespace, key, value, Date.now())) {
      await persist(next);
      cached = next;
    }
  });
}

export function setLocal(
  access: Access,
  namespace: string,
  key: string,
  value: string,
): Promise<void> {
  return writeLocal(access, namespace, key, value);
}

export function deleteLocal(
  access: Access,
  namespace: string,
  key: string,
): Promise<void> {
  return writeLocal(access, namespace, key, null);
}
