# Secrets primitive + Google OAuth client_secret

## Context

Connecting Google in the Accounts pane currently fails with:

```
auth: token endpoint 400 for https://oauth2.googleapis.com/token:
{ "error": "invalid_request", "error_description": "client_secret is missing." }
```

Google's "Desktop app" OAuth client type requires `client_secret` at the token endpoint even with PKCE. This is Google's implementation of RFC 8252 §8.6 — they embed the "soft" secret in the public client as an additional authentication factor. So we must send it.

The literal bug is small (one missing field), but it exposes a systemic gap: `google` has no `clientSecret` config field, and **Notion already stores its `clientSecret` via the `config` plugin as plaintext JSONB in Postgres**. Every provider plugin that needs a client secret ends up with the same question — where do secrets go at rest — and we don't have a primitive answer today.

This plan introduces a **`secrets` primitive plugin** (peer of `jobs` / `events`) that owns encrypted-at-rest key-value storage with OS-keychain-backed key management, then rewires auth's existing token store and adds a `"secret"` field kind to the config plugin. Google and Notion both consume the new field kind; Google's bug is fixed as the final step.

## Design summary

Three architectural choices, already agreed:

1. **Full primitive extraction** — `plugins/secrets/` is a new top-level primitive. Auth's `token-store.ts` / `crypto.ts` / `key-store.ts` get rewritten to consume it, not own it.
2. **Separate encrypted file at rest** — `~/.singularity/secrets.json.enc`, AES-256-GCM, distinct from the legacy `~/.singularity/auth/tokens.json.enc` (which gets migrated once on first boot).
3. **OS keychain for the master key, file fallback** — `@napi-rs/keyring` (macOS Keychain / libsecret / Windows Credential Manager) resolves the 32-byte AES key; falls back to `~/.singularity/secrets/.key` mode 0600 if keychain is unavailable (CI, headless Linux without keyring daemon). Key is cached in-process after first read so macOS only prompts once per server lifetime.

### Dependency DAG

```
config ──────> secrets
auth   ──────> secrets
google/notion providers ──> config (existing), auth (existing)
```

`secrets` is a leaf — imports nothing from other plugins. No cycles.

### Sockets

- `~/.singularity/auth.sock` — **kept**, serves auth's application-level `/token`, `/status`, `/disconnect`, `/api-key`. Refresh logic, consent errors, scope-subset checks.
- `~/.singularity/secrets.sock` — **new**, serves raw `/get`, `/set`, `/delete`, `/has`, `/meta` by `(namespace, key)`. 0600 perms.

Two sockets, not one. Auth's socket already works; collapsing it forces `secrets` to know about auth concepts, violating the DAG. In practice worktrees rarely touch `secrets.sock` because all token reads go through `auth.sock`, which runs on main and calls `getSecret` locally.

### Web boundary

**`plugins/secrets/` has no `web/` folder.** Values never reach the browser. The Settings UI for secret config fields (password inputs, "clear" button) lives in the config plugin. The config plugin exposes a new `configSecretsResource` that broadcasts only `{ set: boolean, updatedAt?: number }` per field — never the plaintext.

## File tree

```
plugins/secrets/
├── CLAUDE.md
├── package.json                     # @singularity/plugin-secrets
│                                    # "@napi-rs/keyring" in optionalDependencies
├── shared/
│   ├── index.ts                     # barrel
│   └── internal/
│       ├── types.ts                 # SecretRef, SecretMetadata
│       └── errors.ts                # SecretsError hierarchy
└── server/
    ├── index.ts                     # barrel: default export + named API
    └── internal/
        ├── paths.ts                 # SECRETS_DIR, STORE_PATH, KEY_PATH, SOCKET_PATH, isMain
        ├── crypto.ts                # moved from plugins/auth (AES-256-GCM)
        ├── key-store.ts             # keychain-first, file-fallback, in-memory cache
        ├── store.ts                 # encrypted blob load/save with writeChain mutex
        ├── api.ts                   # public get/set/has/delete (main direct | worktree RPC)
        ├── boot.ts                  # onReady: migrate → loadKey → initStore → startSocket → resolve `ready`
        ├── ready.ts                 # exports `ready: Promise<void>` consumers await
        ├── migrate-auth-tokens.ts   # one-shot: old auth/tokens.json.enc → secrets namespace
        └── unix-rpc/
            ├── protocol.ts
            ├── server.ts
            └── client.ts
```

## Public API

### `plugins/secrets/shared/index.ts`

```ts
export type { SecretRef, SecretMetadata } from "./internal/types";
export {
  SecretsError,
  SecretsMainOfflineError,
  SecretsKeychainLockedError,
} from "./internal/errors";
```

```ts
// shared/internal/types.ts
export interface SecretRef { namespace: string; key: string; }
export interface SecretMetadata { set: boolean; updatedAt?: number; }
```

### `plugins/secrets/server/index.ts`

```ts
export {
  getSecret, setSecret, deleteSecret, hasSecret,
  getSecretMetadata, listKeysInNamespace,
} from "./internal/api";
export { ready } from "./internal/ready";
export type { SecretRef, SecretMetadata } from "@plugins/infra/plugins/secrets/shared";
export {
  SecretsError, SecretsMainOfflineError, SecretsKeychainLockedError,
} from "@plugins/infra/plugins/secrets/shared";

import { onReady } from "./internal/boot";
export default { id: "secrets", name: "Secrets", onReady };
```

**Signatures**:

```ts
function getSecret(ref: SecretRef): Promise<string | undefined>;    // undefined = not set
function setSecret(ref: SecretRef, value: string): Promise<void>;
function deleteSecret(ref: SecretRef): Promise<void>;
function hasSecret(ref: SecretRef): Promise<boolean>;
function getSecretMetadata(ref: SecretRef): Promise<SecretMetadata>;
function listKeysInNamespace(namespace: string): Promise<string[]>;  // for migrations
```

Values are strings only — callers JSON.stringify at the boundary (auth stores a blob by calling `setSecret({namespace:"auth-tokens", key:"blob-v1"}, JSON.stringify(tokenStoreBlob))`).

### `ready` coordination

Because `onReady` runs with `Promise.all` in `server/src/index.ts:13-19`, plugin ordering in `plugins.ts` is not load-order. Instead:

```ts
// plugins/secrets/server/internal/ready.ts
let resolve!: () => void;
export const ready: Promise<void> = new Promise<void>((r) => { resolve = r; });
export function markReady() { resolve(); }
```

`boot.ts` calls `markReady()` after migration + store-init + socket-up. Auth and config `await ready` inside their own `onReady` before using any secret API.

## Key management (`server/internal/key-store.ts`)

```ts
const KEYCHAIN_SERVICE = "singularity";
const KEYCHAIN_ACCOUNT = "secrets-aes-256-gcm-v1";
let cached: Buffer | null = null;
let keychainModule: typeof import("@napi-rs/keyring") | null | undefined;

async function loadKeychainModule() {
  if (keychainModule !== undefined) return keychainModule;
  try { keychainModule = await import("@napi-rs/keyring"); }
  catch { keychainModule = null; }
  return keychainModule;
}

export async function getEncryptionKey(): Promise<Buffer> {
  if (cached) return cached;
  const mod = await loadKeychainModule();
  if (mod) {
    try {
      const entry = new mod.Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      const existing = entry.getPassword();
      if (existing) {
        cached = Buffer.from(existing, "base64");
        if (cached.length !== 32) throw new Error("bad key length in keychain");
        return cached;
      }
      const fresh = randomBytes(32);
      entry.setPassword(fresh.toString("base64"));
      cached = fresh;
      return cached;
    } catch (err) {
      console.warn("[secrets] keychain unavailable, falling back to file:", err);
    }
  }
  cached = readOrCreateKeyFile();  // existing plugins/auth/server/internal/key-store.ts logic
  return cached;
}
```

Cached after first read so macOS prompts once per process lifetime.

`@napi-rs/keyring` declared in `optionalDependencies` — missing native prebuilts won't block install.

## Config plugin extensions

### `FieldKind` addition (`plugins/config/shared/internal/lib.ts`)

```ts
export type FieldKind = "string" | "number" | "boolean" | "string-list" | "secret";

export interface FieldMeta<T> {
  default: T;
  description?: string;
  label?: string;
  secret?: boolean;  // string-only; implies kind="secret"
}
```

`normalize()`: when `meta.secret === true`, emit `{ kind: "secret", default: "" }`.
`validateKind("secret", v)`: require `typeof v === "string"`.

### New `configSecretsResource` (`plugins/config/server/internal/resource.ts`)

Separate from `configResource`. Broadcasts only metadata:

```ts
export const configSecretsResource = defineResource<
  Record<string, { set: boolean; updatedAt?: number }>
>({
  key: "config-secrets",
  mode: "push",
  async loader() {
    const out: Record<string, { set: boolean; updatedAt?: number }> = {};
    for (const { pluginId, fields } of getRegistry()) {
      for (const f of fields) {
        if (f.kind !== "secret") continue;
        const fk = fullKey(pluginId, f.key);
        out[fk] = await getSecretMetadata({ namespace: "config-fields", key: fk });
      }
    }
    return out;
  },
});
```

Non-secret fields continue to flow through the existing `configResource` unchanged.

### PATCH/DELETE routing (`plugins/config/server/internal/handlers.ts`)

```ts
const field = getField(body.key);
if (field?.kind === "secret") {
  const ref = { namespace: "config-fields", key: body.key };
  if (body.value === "") await deleteSecret(ref);
  else await setSecret(ref, String(body.value));
  configSecretsResource.notify();
  invalidateCredentialsCacheFor(body.key);  // hook into auth — see below
  return json({ ok: true, key: body.key, set: body.value !== "" });
}
// ... existing non-secret Postgres path unchanged
```

`DELETE /api/config/:key` similarly branches.

`invalidateCredentialsCacheFor` is a tiny event the config plugin emits; auth's `resolveCredentials` cache (`plugins/auth/server/internal/credentials.ts`) listens. Simplest wire: a shared `EventEmitter` exported from a new `plugins/config/server` named export `configChanged` — auth listens in its own `onReady`. (Or lean on the existing `configResource` notify; auth already re-reads credentials lazily, so this may be a no-op — verify during implementation.)

### `readConfig` branch (`plugins/config/server/internal/read-config.ts`)

```ts
for (const f of fields) {
  if (f.kind === "secret") {
    const v = await getSecret({ namespace: "config-fields", key: fullKey(pluginId, f.key) });
    out[f.key] = v ?? "";
    continue;
  }
  // existing Postgres read via cache
}
```

This works identically on main (local `getSecret`) and worktrees (routed via `secrets.sock`). The `read-cache` layer continues to serve non-secret fields only.

### Web: `<SecretField>` component

Extend `plugins/config/web/components/field.tsx` with a password input, show/hide toggle, clear button. Critical UX rules:

- Never render a `value` from `useConfigValues` — the input is uncontrolled w.r.t. the server.
- On successful commit, blank the local input.
- Placeholder shows `•••••••• (saved)` when `useSecretFieldSet(fk).set`.
- "Clear" sends `""` → `deleteSecret` on the server.

New hook `useSecretFieldSet(fullKey)` reads the `configSecretsResource`.

## Auth plugin refactor

### Move to `plugins/secrets/server/internal/`

- `plugins/auth/server/internal/crypto.ts` → `plugins/secrets/server/internal/crypto.ts` (verbatim)
- `plugins/auth/server/internal/key-store.ts` → rewritten as described in §Key management

### Delete from `plugins/auth/server/internal/`

- `crypto.ts`, `key-store.ts`
- Trim `paths.ts`: drop `KEY_PATH`; keep `AUTH_DIR` + `TOKEN_STORE_PATH` (migration only); keep `SOCKET_PATH`, `isMain`, etc.

### Rewrite `plugins/auth/server/internal/token-store.ts`

Keep all exported names (`getAccount`, `setAccount`, `patchAccount`, `deleteAccount`, `listAccounts`, `listProviderIdsWithAccounts`, the `StoredAccount`/`TokenStoreBlob` types). Replace persistence with secrets-backed blob:

```ts
import { getSecret, setSecret, ready as secretsReady } from "@plugins/infra/plugins/secrets/server";

const NS = "auth-tokens";
const KEY = "blob-v1";
let cached: TokenStoreBlob | null = null;
const writeChain: Promise<void> = Promise.resolve();

export async function initTokenStore(): Promise<void> {
  await secretsReady;
  const raw = await getSecret({ namespace: NS, key: KEY });
  cached = raw ? (JSON.parse(raw) as TokenStoreBlob) : { version: 1, providers: {} };
}

async function persist(next: TokenStoreBlob): Promise<void> {
  cached = next;
  await setSecret({ namespace: NS, key: KEY }, JSON.stringify(next));
}
// setAccount/patchAccount/deleteAccount: read-modify-write via writeChain mutex as today
```

The in-process `cached` + `writeChain` mutex still matters — they protect the read-modify-write of the structured blob. Secrets' own mutex (inside `store.ts`) protects the rename-atomic file write. Both needed, both orthogonal.

### Keep auth's unix socket

`auth.sock` continues to serve `/token`, `/status`, `/disconnect`, `/api-key` unchanged. Refresh logic, consent errors, in-flight dedup — all stay in auth.

### Keep `AuthKeychainLockedError` for back-compat

Existing callers may catch it. Wrap the secrets-side error with `cause`:

```ts
try { await initTokenStore(); }
catch (err) {
  if (err instanceof SecretsKeychainLockedError) {
    throw new AuthKeychainLockedError({ cause: err });
  }
  throw err;
}
```

Zero breaking change for consumers.

### One-shot migration (`plugins/secrets/server/internal/migrate-auth-tokens.ts`)

Runs in `secrets`' `onReady`, before the socket opens, before `markReady()`:

```ts
const LEGACY_BLOB = path.join(homedir(), ".singularity", "auth", "tokens.json.enc");
const LEGACY_KEY  = path.join(homedir(), ".singularity", "auth", ".key");

export async function migrateLegacyAuthTokens(): Promise<"migrated"|"skipped"|"noop"> {
  if (!existsSync(LEGACY_BLOB) || !existsSync(LEGACY_KEY)) return "noop";
  if (await hasSecret({ namespace: "auth-tokens", key: "blob-v1" })) return "skipped";
  const legacyKey = readFileSync(LEGACY_KEY);
  if (legacyKey.length !== 32) throw new Error("[secrets] legacy key wrong length");
  const plaintext = decrypt(readFileSync(LEGACY_BLOB), legacyKey).toString("utf8");
  const parsed = JSON.parse(plaintext);
  if (parsed.version !== 1 || !parsed.providers) throw new Error("[secrets] bad blob shape");
  await setSecret({ namespace: "auth-tokens", key: "blob-v1" }, plaintext);
  const ts = Date.now();
  renameSync(LEGACY_BLOB, `${LEGACY_BLOB}.migrated-${ts}`);
  renameSync(LEGACY_KEY,  `${LEGACY_KEY}.migrated-${ts}`);
  return "migrated";
}
```

Rename, not delete — recoverable if something goes wrong. Idempotent on re-run because of the `hasSecret` check.

## Google + Notion fixes

### `plugins/auth/plugins/google/shared/config.ts`

```ts
export const googleAuthConfig = defineConfig({
  clientId: {
    default: "",
    label: "OAuth Client ID",
    description:
      "Desktop-app client ID from Google Cloud Console. " +
      "Add http://localhost:9000/api/auth/callback/google as the Authorized redirect URI.",
  },
  clientSecret: {
    default: "",
    secret: true,
    label: "OAuth Client Secret",
    description:
      "Desktop-app client secret from Google Cloud Console. Required by Google's token " +
      "endpoint even with PKCE. Stored encrypted on main only, never sent to worktrees' browsers.",
  },
});
```

### `plugins/auth/plugins/google/server/internal/descriptor.ts`

```ts
resolveCredentials: async (env) => {
  const idFromEnv = env.get("SINGULARITY_AUTH_GOOGLE_CLIENT_ID");
  const secretFromEnv = env.get("SINGULARITY_AUTH_GOOGLE_CLIENT_SECRET");
  if (idFromEnv) {
    return { clientId: idFromEnv, clientSecret: secretFromEnv };
  }
  const cfg = await readConfig(googleAuthConfig);
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new AuthCredentialsMissingError("google");
  }
  return { clientId: cfg.clientId, clientSecret: cfg.clientSecret };
},
```

### `plugins/auth/plugins/notion/shared/config.ts`

Flip `clientSecret` to `secret: true`. Descriptor unchanged — it already passes `cfg.clientSecret` through.

### Notion plaintext-to-secret migration

Runs in config plugin's `onReady`, after `await secretsReady`:

```ts
// plugins/config/server/internal/migrate-secrets.ts
export async function migratePlaintextSecretsToSecretStore() {
  for (const { pluginId, fields } of getRegistry()) {
    for (const f of fields) {
      if (f.kind !== "secret") continue;
      const fk = fullKey(pluginId, f.key);
      const row = await db.select().from(config).where(eq(config.key, fk));
      if (row.length === 0) continue;
      const plaintext = row[0]!.value;
      if (typeof plaintext !== "string" || !plaintext) {
        await db.delete(config).where(eq(config.key, fk));
        continue;
      }
      await setSecret({ namespace: "config-fields", key: fk }, plaintext);
      await db.delete(config).where(eq(config.key, fk));
    }
  }
}
```

Idempotent: after first run the rows are gone, subsequent boots no-op.

## Ordering of work

Seven commits, each independently buildable and testable. Each will be pushed via `./equin push -m "…"` (per project rules) only when the user says to ship.

1. **Land `plugins/secrets/` standalone.** Full plugin, `@napi-rs/keyring` optional dep, migration code, socket + RPC. Register in `server/src/plugins.ts`. Nothing consumes it yet. `./equin build` succeeds, zero behavior change.

2. **Migrate auth to use secrets.** Rewrite `token-store.ts`, delete `crypto.ts` + `key-store.ts` from auth, wrap error types. First boot after this step migrates `tokens.json.enc` → secrets namespace. Smoke: pre-existing Google connection (from old code) survives through the migration.

3. **Add `"secret"` field kind to config.** `FieldKind` union, `normalize`, `validateKind`, PATCH/DELETE branches, `configSecretsResource`, `<SecretField>` component, `useSecretFieldSet` hook, plaintext-to-secret migration. No plugin uses it yet — zero behavior change.

4. **Add Google `clientSecret` field.** Updates `googleAuthConfig` + `resolveCredentials`. **This is the step that fixes the original bug.** Users who had only `clientId` set before this step now see `AuthCredentialsMissingError` until they paste the secret — acceptable: the feature was broken for them anyway.

5. **Flip Notion `clientSecret` to secret.** Migration step 3's code moves the existing plaintext row out of Postgres on first boot. Idempotent.

6. **Update `plugins/auth/CLAUDE.md`.** Remove "OS keychain deferred" note, point at `plugins/secrets/CLAUDE.md`.

7. **Regenerate `docs/plugins.md`.** `./equin build` does this.

## Verification

### Happy-path smoke

1. `./equin build`. Check logs for `[secrets] keychain available` or `falling back to file`, and (first deploy only) `[secrets] migrated legacy auth tokens`.
2. At `http://equin.localhost:9000`, Settings → Google section. Paste clientId (plain) and clientSecret (password input). Blur to commit.
3. ClientSecret field should now render `•••••••• (saved)` after commit.
4. Accounts pane → Google → Connect. Complete Google consent. Popup closes; email shown. **Token exchange should succeed** (was the failure mode).
5. On a worktree, any consumer calling `getAccessToken("google", {scopes:[...]})` should get a valid access token via `auth.sock`. Force expiry to exercise refresh path — refresh endpoint POST body should include `client_secret=…` (temporarily log in `oauth-flow.ts:refreshAccessToken` to verify).

### Regression checks

- Non-secret config fields unchanged: pick any existing field, PATCH → Postgres row → `configResource` push.
- Notion pre-migration: set a plaintext clientSecret on the old code, deploy this change, verify on boot the Postgres row disappears and the value survives via `getSecret`.
- Fallback path: temporarily rename `@napi-rs/keyring` in `node_modules` (or set an env to short-circuit the dynamic import), boot, confirm `~/.singularity/secrets/.key` gets created, confirm set/get round-trips.

## Critical files

- **New plugin**: `plugins/secrets/server/internal/{api,key-store,store,boot,ready,migrate-auth-tokens,crypto,paths}.ts`, `plugins/secrets/server/internal/unix-rpc/*`, `plugins/secrets/shared/internal/{types,errors}.ts`, `plugins/secrets/{server,shared}/index.ts`, `plugins/secrets/package.json`, `plugins/secrets/CLAUDE.md`.
- **Auth rewrite**: `plugins/auth/server/internal/token-store.ts` (full rewrite), `plugins/auth/server/internal/paths.ts` (trim), `plugins/auth/server/internal/boot.ts` (`await secretsReady`).
- **Auth deletions**: `plugins/auth/server/internal/crypto.ts`, `plugins/auth/server/internal/key-store.ts`.
- **Config extensions**: `plugins/config/shared/internal/lib.ts` (FieldKind, FieldMeta.secret), `plugins/config/server/internal/{handlers,read-config,resource}.ts`, `plugins/config/server/internal/migrate-secrets.ts` (new), `plugins/config/web/components/field.tsx` (+ `SecretField`), `plugins/config/web/internal/config-client.ts` (+ `useSecretFieldSet`).
- **Google fix**: `plugins/auth/plugins/google/shared/config.ts`, `plugins/auth/plugins/google/server/internal/descriptor.ts`.
- **Notion flip**: `plugins/auth/plugins/notion/shared/config.ts`.
- **Registration**: `server/src/plugins.ts` (add secrets).
- **Docs**: `plugins/auth/CLAUDE.md` (update), `docs/plugins.md` (auto-regenerated).
