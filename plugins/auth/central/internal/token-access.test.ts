import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { AuthProviderDescriptor } from "@plugins/auth/core";
import type { StoredAccount } from "./token-store";

// A Google-like provider whose token endpoint is unreachable: the refresh's
// fetch rejects the way Bun's does when DNS is down (report-1794655441-55bxvr).
const descriptor = {
  id: "google-test",
  kind: "oauth2",
  oauth: { tokenUrl: "https://oauth2.googleapis.com/token" },
} as unknown as AuthProviderDescriptor;

let account: StoredAccount;
const patches: Partial<StoredAccount>[] = [];

void mock.module("./registry", () => ({
  getProvider: () => descriptor,
  listProviders: () => [descriptor],
}));
void mock.module("./credentials", () => ({
  resolveCredentials: () => Promise.resolve({ clientId: "client" }),
}));
void mock.module("./token-store", () => ({
  getAccount: () => account,
  patchAccount: (_p: string, _a: string, patch: Partial<StoredAccount>) => {
    patches.push(patch);
    account = { ...account, ...patch };
    return Promise.resolve(account);
  },
}));

const { getAccessTokenInternal } = await import("./token-access");

const realFetch = globalThis.fetch;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  account = {
    kind: "oauth2",
    accessToken: "stale",
    refreshToken: "refresh",
    expiresAt: Date.now() - 1,
    connectedAt: Date.now() - 1000,
  } as StoredAccount;
  patches.length = 0;
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  globalThis.fetch = (() => {
    const err = new TypeError(
      "getaddrinfo ENOTFOUND oauth2.googleapis.com",
    ) as TypeError & { code: string };
    err.code = "ENOTFOUND";
    return Promise.reject(err);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  globalThis.fetch = realFetch;
});

/** A real macrotask turn, so a dangling rejection gets reported. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 20));

test("an unreachable token endpoint is a failed result, not an unhandled rejection", async () => {
  const result = await getAccessTokenInternal({ providerId: descriptor.id });
  await settle();

  expect(result).toEqual({
    ok: false,
    message: "getaddrinfo ENOTFOUND oauth2.googleapis.com",
  });
  expect(unhandled).toEqual([]);
  // The failure stays visible on the account, which keeps its grant.
  expect(account.lastRefreshError?.message).toBe(
    "getaddrinfo ENOTFOUND oauth2.googleapis.com",
  );
  expect(account.needsReconsent).toBeUndefined();
});

test("concurrent callers share one refresh, and the next call after a failure refreshes again", async () => {
  const [a, b] = await Promise.all([
    getAccessTokenInternal({ providerId: descriptor.id }),
    getAccessTokenInternal({ providerId: descriptor.id }),
  ]);
  await settle();
  expect(a.ok).toBe(false);
  expect(b.ok).toBe(false);
  expect(patches).toHaveLength(1);
  expect(unhandled).toEqual([]);

  await getAccessTokenInternal({ providerId: descriptor.id });
  expect(patches).toHaveLength(2);
});
