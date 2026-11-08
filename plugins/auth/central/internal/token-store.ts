import type { AuthIdentity, AuthProviderKind } from "@plugins/auth/core";
import { AuthKeychainLockedError } from "@plugins/auth/core";
import {
  getSecret,
  ready as secretsReady,
  setSecret,
  SecretsKeychainLockedError,
} from "@plugins/infra/plugins/secrets/central";
import { defineSecretNamespace } from "@plugins/infra/plugins/secrets/core";

export interface StoredAccount {
  kind: AuthProviderKind;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  idToken?: string;
  apiKey?: string;
  identity: AuthIdentity;
  connectedAt: number;
  lastRefreshedAt?: number;
  needsReconsent?: boolean;
  lastRefreshError?: { message: string; at: number };
}

export interface TokenStoreBlob {
  version: 1;
  providers: {
    [providerId: string]: {
      [accountId: string]: StoredAccount;
    };
  };
}

const NAMESPACE = defineSecretNamespace("auth-tokens", { scope: "machine" });
const BLOB_KEY = "blob-v1";
const EMPTY_BLOB: TokenStoreBlob = { version: 1, providers: {} };

let cached: TokenStoreBlob | null = null;
// Single-writer mutex to serialize read-modify-write cycles on the in-memory
// blob. The secrets store has its own write mutex for the rename-atomic file
// write — both are needed (orthogonal concerns).
let writeChain: Promise<unknown> = Promise.resolve();

function parseBlob(raw: string | undefined): TokenStoreBlob {
  if (!raw) return { ...EMPTY_BLOB };
  const parsed = JSON.parse(raw) as TokenStoreBlob;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- forward-compat guard; parsed JSON may have any shape
  if (parsed.version !== 1 || !parsed.providers) {
    throw new Error("auth: token store has unexpected shape");
  }
  return parsed;
}

export async function initTokenStore(): Promise<void> {
  try {
    await secretsReady;
    const raw = await getSecret({ namespace: NAMESPACE, key: BLOB_KEY });
    cached = parseBlob(raw);
  } catch (err) {
    if (err instanceof SecretsKeychainLockedError) {
      throw new AuthKeychainLockedError(err.message);
    }
    throw err;
  }
}

function ensureLoaded(): TokenStoreBlob {
  if (!cached) {
    throw new Error(
      "auth: token store not initialized; call initTokenStore() first",
    );
  }
  return cached;
}

async function persist(): Promise<void> {
  const blob = ensureLoaded();
  await setSecret(
    { namespace: NAMESPACE, key: BLOB_KEY },
    JSON.stringify(blob),
  );
}

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  // eslint-disable-next-line promise-safety/no-absorbed-failure -- chain-tail catch only keeps the retained `writeChain` from becoming an unhandled rejection; the real error still propagates to the caller via the returned `next`
  writeChain = next.catch(() => undefined);
  return next;
}

export function getAccount(
  providerId: string,
  accountId = "primary",
): StoredAccount | undefined {
  const blob = ensureLoaded();
  return blob.providers[providerId]?.[accountId];
}

export function listAccounts(
  providerId: string,
): Array<[string, StoredAccount]> {
  const blob = ensureLoaded();
  const accounts = blob.providers[providerId];
  if (!accounts) return [];
  return Object.entries(accounts);
}

export function listProviderIdsWithAccounts(): string[] {
  const blob = ensureLoaded();
  return Object.keys(blob.providers);
}

export async function setAccount(
  providerId: string,
  accountId: string,
  account: StoredAccount,
): Promise<void> {
  return enqueueWrite(async () => {
    const blob = ensureLoaded();
    if (!blob.providers[providerId]) blob.providers[providerId] = {};
    blob.providers[providerId]![accountId] = account;
    await persist();
  });
}

export async function patchAccount(
  providerId: string,
  accountId: string,
  patch: Partial<StoredAccount>,
): Promise<StoredAccount | undefined> {
  return enqueueWrite(async () => {
    const blob = ensureLoaded();
    const existing = blob.providers[providerId]?.[accountId];
    if (!existing) return undefined;
    const updated: StoredAccount = { ...existing, ...patch };
    blob.providers[providerId]![accountId] = updated;
    await persist();
    return updated;
  });
}

export async function deleteAccount(
  providerId: string,
  accountId = "primary",
): Promise<StoredAccount | undefined> {
  return enqueueWrite(async () => {
    const blob = ensureLoaded();
    const accounts = blob.providers[providerId];
    if (!accounts) return undefined;
    const removed = accounts[accountId];
    if (!removed) return undefined;
    delete accounts[accountId];
    if (Object.keys(accounts).length === 0) delete blob.providers[providerId];
    await persist();
    return removed;
  });
}
