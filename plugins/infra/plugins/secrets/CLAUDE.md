# Secrets

Encrypted-at-rest key-value primitive. Consumers: `auth` (OAuth tokens / API keys) and `config` (fields declared with `secret: true`).

## Topology

- **Storage lives on the central runtime.** `~/.equin/state/secrets/secrets.json.enc` (AES-256-GCM) is read and written by the singleton `central` backend (gateway-supervised, headless). Worktree backends never touch the file.
- **OS keychain for the master key, file fallback; the file on Linux.** macOS / Windows: `@napi-rs/keyring` (Keychain / Credential Manager), falling back to `~/.equin/state/secrets/.key` (mode 0600) when the native module is missing or fails at runtime. Linux: that file only, by design — the keyring's Linux backends are the Secret Service (absent or locked on a headless server) and the kernel keyring (gone at reboot), so the key would differ between boots. Either way the key is cached in-memory after first read.
- **The key source is sticky.** A keychain with no entry defers to a `.key` an earlier fallback wrote, and no path mints a new key while `secrets.json.enc` exists — it throws `SecretsKeychainLockedError` instead, since a fresh key could never read that blob and the next write would replace every secret.
- **Worktrees call central over HTTP via the gateway.** `getSecret`/`setSecret`/`deleteSecret`/`hasSecret`/`getSecretMetadata`/`listKeysInNamespace` (`server/`) go through the `SecretStore` host service (`secrets.store`); its one provider is the `machine/` half (`centralSecretStore`), which POSTs JSON to `http://localhost:9000/api/secrets/*`. No browser host provides it, so — portability rule 3 (`boundaries/core`) — `infra/secrets/server` and every server barrel loading it are not portable and never boot in a browser host (where `localhost:9000` would be the visitor's own machine). A process that runs this code without booting a graph (the agent process, `./equin deploy`) names the provider itself: `provideHostServicesUnbooted([SecretStore.provide(centralSecretStore)])`, `centralSecretStore` from `infra/secrets/cli` (a `bin/` cannot import `machine/`). The gateway routes those prefixes to `central` regardless of host (see `~/.equin/state/gateway/central-routes.json`). The previous unix-socket RPC and `~/.equin/secrets.sock` are gone.
- **Boot is in central's `onReady`.** Central's plugin definition (`plugins/infra/plugins/secrets/central/index.ts`) loads the keychain, hydrates the encrypted blob, and runs the legacy `~/.equin/state/auth/tokens.json.enc` migration before the HTTP handlers are reachable. The server-side `ready` promise resolves immediately — there's nothing to wait for in-process.

## Namespaces and scopes

Secrets are addressed by `{ namespace, key }`, where `namespace` is a declared `SecretNamespace` — `defineSecretNamespace(id, { scope })` (`core/`), spelled once by the plugin owning it. A ref naming an undeclared namespace does not compile; one id declared with two scopes throws.

- **`scope: "machine"`** — the user's credential, one value for every namespace on the computer (sign in once, every worktree works): `auth-tokens` (auth's `TokenStoreBlob`, keyed `blob-v1`), `claude-accounts` (per account id), `config-fields` (per config full-key, `fields/secret/config`'s `CONFIG_FIELD_SECRETS`).
- **`scope: "instance"`** — the value belongs to the instance writing it, like its DB rows (a worktree gets a fork of main's DB, not main's DB): `deploy-secrets`, `deploy-ssh`, `deploy-secret-grants`. Central keeps a **base layer** (main's) and one **overlay per caller namespace**:
  - main (`MAIN_WORKTREE_NAME` exactly — `promo-film.<main checkout>` is not main) reads and writes the base;
  - any other namespace reads its overlay, falling through to the base, and writes / deletes only its overlay (a delete is a tombstone, so main's value does not reappear). A seed or a worktree testing Set value gets its own copy and never touches main's;
  - a caller that names no namespace reads the base, and its write is refused — 403 over HTTP (`InstanceWriteRefusedError` in central).

The scope travels on every request body, read off the ref's `SecretNamespace`. The caller's namespace rides in `SECRETS_CALLER_HEADER` (`core/`): `centralSecretStore` stamps `runtimeNamespace()` per call (none when the process declared none — the agent process, a test preload without one); a CLI that acts for a checkout uses `centralSecretStoreFor(ns)` (`./equin deploy` reads its checkout's `deploy-ssh` key). The header is the caller's own claim — an accident guard against our own code, not authentication (single-instance ADR).

Central's in-process API (`central/`: auth, `fields/secret/config`'s central half) takes machine namespaces only and throws on an instance one: central serves every namespace and runs as none.

A backend built before scopes existed sends no `scope`; central resolves it from a closed record of the three pre-scope instance namespaces (`central/internal/legacy-scope.ts`) — never as `machine`.

Overlays of removed worktrees are not reclaimed yet (entries are tiny and bounded by namespaces).

## Write history

Every entry (base and overlay) keeps its last 20 writes, `{ at, op: "set" | "delete", by: <caller namespace> | null, changed }` (`changed`: the value differs from the one the caller saw before). Never a value or a digest. `getSecretMetadata` returns `{ set, updatedAt?, history }`; the Deploy app's Secrets section shows each row's last write from it.

The blob is `{ version: 2, namespaces /* base */, overlays: { [caller]: { [ns]: { [key]: entry } } } }`; a v1 blob (no history, no overlays) upgrades in place on load (`central/internal/layers.ts`, the pure layering / history / upgrade logic, tested without a keychain or a file).

## No `web/`

The secrets plugin has no frontend. Plaintext secret values must never flow to a browser. UIs that need to show "is this secret set?" consume the `config-fields` metadata through the config plugin's `configSecretsResource`, which only broadcasts `{ set: boolean }`.

## Migration from pre-secrets auth

On central's first boot after upgrade, `migrateLegacyAuthTokens` decrypts `~/.equin/state/auth/tokens.json.enc` with its own `.key`, writes the blob under `auth-tokens/blob-v1`, and renames both legacy files to `.migrated-<timestamp>`. Idempotent — subsequent boots see the secret already present and no-op.

## Explicit deferrals

- **Hardware-backed keys** (Secure Enclave / TPM). Overkill for a dev tool.
- **Key rotation.** No `rotateKey()` yet; the blob version byte in `crypto.ts` gives us a hook if we need it.
- **Per-secret ACLs.** HTTP access is gated by the localhost trust boundary — same threat model as every other dev tool, and unchanged from when the unix socket gated reads with 0600 file permissions.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The secrets API every backend calls (getSecret / setSecret / deleteSecret / hasSecret / getSecretMetadata / listKeysInNamespace), through the SecretStore host service (secrets.store) — provided on the computer by the machine half, a client of central's store. No browser host provides it, so nothing that reads secrets runs in one. Encrypted key-value primitive. AES-256-GCM blob at ~/.equin/state/secrets/secrets.json.enc with the master key in the OS keychain (fallback to the .key beside it). Hosted on the central runtime; consumers (auth, config) call /api/secrets/* via the gateway.
- Load-bearing: yes
- Server:
  - Contributes: `host-service:secrets.store` "secrets.store"
  - Exports (types):
    - `SecretMetadata`
    - `SecretRef`
    - `SecretStoreImpl`
  - Exports (values):
    - `deleteSecret`
    - `getSecret`
    - `getSecretMetadata`
    - `hasSecret`
    - `listKeysInNamespace`
    - `ready`
    - `SecretsError`
    - `SecretsKeychainLockedError`
    - `SecretsMainOfflineError`
    - `SecretStore`
    - `setSecret`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `infra/namespace.isNamespace`
    - `packages/list-bound.cappedList`
  - Exports (types):
    - `SecretMetadata`
    - `SecretNamespace`
    - `SecretRef`
    - `SecretScope`
    - `SecretWrite`
  - Exports (values):
    - `defineSecretNamespace`
    - `SECRET_HISTORY_LIMIT`
    - `SECRETS_CALLER_HEADER`
    - `secretsDelete`
    - `SecretsError`
    - `secretsGet`
    - `secretsHas`
    - `SecretsKeychainLockedError`
    - `secretsList`
    - `SecretsMainOfflineError`
    - `secretsMeta`
    - `secretsSet`
    - `SecretWriteSchema`
- Cross-plugin:
  - Imported by:
    - `apps/deploy/deploy-secrets/approvals`
    - `apps/deploy/servers`
    - `auth`
    - `auth/apple-signing`
    - `backup/sources/platform`
    - `backup/sources/secrets`
    - `fields/secret/config`
    - `framework/cli/deploy`
    - `infra/claude-cli/accounts`
- Exemptions:
  - Exempts itself from: `paths:no-hardcoded-paths` — `central/index.ts` (sanctioned)
- Machine:
  - Exports (values):
    - `centralSecretStore`
    - `centralSecretStoreFor`
- Central:
  - Exports (types):
    - `SecretMetadata`
    - `SecretRef`
  - Exports (values):
    - `deleteSecret`
    - `getSecret`
    - `getSecretMetadata`
    - `hasSecret`
    - `listKeysInNamespace`
    - `ready`
    - `SecretsError`
    - `SecretsKeychainLockedError`
    - `setSecret`
  - Routes:
    - `POST /api/secrets/get`
    - `POST /api/secrets/set`
    - `POST /api/secrets/delete`
    - `POST /api/secrets/has`
    - `POST /api/secrets/meta`
    - `POST /api/secrets/list`
- Cli:
  - Exports (values):
    - `centralSecretStore`
    - `centralSecretStoreFor`

<!-- AUTOGENERATED:END -->
