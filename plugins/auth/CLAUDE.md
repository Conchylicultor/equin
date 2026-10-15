# Auth

Centralized OAuth 2.0 / API key / password sign-in infrastructure for third-party services. Provider sub-plugins live in `plugins/auth/plugins/<id>/`.

## Provider kinds

The closed list is `AUTH_PROVIDER_KINDS` in `core/internal/lib.ts`; everything that branches on a kind (the descriptor check, the token read, the Accounts row) is exhaustive — a `switch` with a `never` default, or a `Record` over every kind — so a new kind is a type error wherever it is unhandled.

- **`oauth2`** — popup consent flow, refresh loop. `descriptor.oauth`.
- **`apikey`** — the user pastes a key (usually through a setup pane the provider registers as `credentialsPane`); `descriptor.apiKey.verify` probes it before it is stored.
- **`password`** — the user types a username + password once, in the generic sign-in dialog the Accounts row opens (`web/components/password-sign-in-dialog.tsx`). `POST /api/auth/sign-in/:provider` hands them to `descriptor.password.exchange`, which trades them for the provider's long-lived token and throws the provider's own message on a rejection. Central stores **only the token** (in the same `apiKey` field an API key uses) and drops the password — never persisted, never logged; a stored password would be a strictly worse secret to hold. The web contribution's `passwordSignIn` carries the dialog's wording (username label, sign-up link). Example: `auth/plugins/hooktheory`.

`apikey` and `password` accounts are both *static credentials*: `getAccessToken` / `getTokenFromCentral` return the stored value with `expiresAt: MAX_SAFE_INTEGER` and no scopes. Nothing marks one stale (the refresh loop walks only oauth2), and Disconnect deletes it locally without revoking it upstream — when the provider revokes it, the next call fails and the user signs in again.

## Topology

- **Auth runs on the central runtime.** The OAuth flow handlers, token store, refresh loop, provider registry, and `authStateServed` (the central `serveValue` of `core`'s `authState` live value, declared `origin: "central"`) all live under `plugins/auth/central/`. There is one auth process for the user, shared across every worktree.
- **Tokens persist via the central secrets store.** Encrypted blob at `~/.singularity/state/secrets/secrets.json.enc`, keyed `{ namespace: "auth-tokens", key: "blob-v1" }`. Auth/central calls into secrets/central directly (same process; no HTTP round-trip). See [`plugins/infra/plugins/secrets/CLAUDE.md`](../infra/plugins/secrets/CLAUDE.md).
- **Browsers reach auth through the gateway's central-routes manifest.** `/api/auth/*` and the live-state WebSocket `/ws/central-notifications` are listed in `~/.singularity/state/gateway/central-routes.json` and forwarded to the central backend regardless of which subdomain the request arrived on. The OAuth redirect URI stays at bare `http://localhost:9000/api/auth/callback/<provider>` — the manifest covers it.
- **A provider added on a branch reads "Unavailable" in its own worktree's Accounts pane.** Central runs main's code, so it knows the provider only once the branch is merged; the row says so instead of offering a Connect that central would reject.
- **Cross-worktree sync is automatic.** When central mutates auth state (connect, disconnect, refresh) it calls `authStateServed.notify()` and central pushes updates to every browser tab subscribed to `/ws/central-notifications`. No fanout, no `~/.singularity/worktrees/*.json` enumeration.

## How a consumer plugin uses it

In-process (another central plugin):

```ts
import { getAccessToken, AuthNeedsConsentError } from "@plugins/auth/central";

try {
  const { accessToken } = await getAccessToken({
    providerId: "google",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  // call provider API with Authorization: Bearer accessToken
} catch (err) {
  if (err instanceof AuthNeedsConsentError) {
    // tell the user to visit Accounts and reconnect
  }
}
```

A worktree backend that needs a token currently has no in-process helper — it would `fetch("http://localhost:9000/api/auth/token", …)` against central via the gateway. No such consumer exists yet; we add the helper when one does.

## How a provider sub-plugin is structured

An OAuth provider (an `apikey` or `password` provider skips `shared/` and `server/` — it has no client credentials to configure; see `google-maps` / `hooktheory`):

```
plugins/auth/plugins/<id>/
├── package.json
├── shared/
│   ├── config.ts       # defineConfig("auth-<id>", { fields: { clientId: secretField(...), ... } })
│   └── index.ts        # export the descriptor + scopes
├── server/
│   └── index.ts        # ConfigV2.Register({ descriptor }) — surfaces fields in Settings UI
├── central/
│   ├── index.ts        # default-export plugin definition + side-effect import of register.ts
│   └── internal/
│       ├── descriptor.ts  # defineAuthProvider(...) — resolveCredentials uses readSecretConfig()
│       └── register.ts    # registerAuthProvider(descriptor) at module top-level
└── web/
    └── index.ts        # Auth.Provider({ id, name, icon }) + ConfigV2.WebRegister({ descriptor })
```

The provider's `central/internal/register.ts` runs at module init and calls `registerAuthProvider`. Module init order in `central/src/plugins.ts` puts the auth root plugin before its providers, so the registry is populated before any provider's first OAuth request. The worktree-side `server/index.ts` registers the config descriptor with config_v2 so the Settings UI renders the fields.

## Credentials

OAuth client credentials (`clientId`, `clientSecret`) are user-supplied via the Settings pane. Both use `secretField()` from config_v2, which stores values in the central secrets store under `{ namespace: "config-fields", key: "auth-<provider>.<field>" }`. Provider descriptors read them via `readSecretConfig()` from `@plugins/fields/plugins/secret/plugins/config/central`.

Env-var overrides for developers:
- `SINGULARITY_AUTH_<PROVIDER>_CLIENT_ID`
- `SINGULARITY_AUTH_<PROVIDER>_CLIENT_SECRET` (where applicable)

Google uses Desktop-app + PKCE, but the token endpoint **still requires** `client_secret` (Google's implementation of RFC 8252 §8.6). Notion uses web-integration and also requires both. Shipping our own verified Google credentials is deferred — see [research/2026-04-24-global-auth-plugin.md](../../research/2026-04-24-global-auth-plugin.md) §I.

## Explicit deferrals

- **Multi-account per provider.** Schema keys accounts by `accountId`; code paths assume `"primary"` until we add an account picker.
- **Revoke on disconnect.** `descriptor.oauth.revoke` is a hook in the type but unused. MVP deletes locally only.
- **Rate-limited refresh retries.** Unconditional 60 s tick. Acceptable until something proves otherwise.
- **Scope-merging UI.** Incremental scope requests trigger full re-consent. Google's `include_granted_scopes=true` is already passed in `buildAuthorizeParams`, so providers should generally re-grant cleanly.
- **Keychain unlock UX.** If the secrets primitive cannot resolve its master key at boot, the `auth-state` value returns providers with `credentialsConfigured: false` and the UI surfaces the configuration empty-state. No web UI to repair the keychain itself.

## Verification

See the Phase 3 plan in [research/2026-04-28-global-phase-3-auth-to-central.md](../../research/2026-04-28-global-phase-3-auth-to-central.md) for the manual smoke test.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Shared authentication infrastructure (OAuth 2.0, API keys, password sign-in). Exposes the accounts pane + Auth.Provider slot; the Settings app surfaces the Account entry. Worktree-side auth helpers. Provides getTokenFromCentral() for worktree plugins that need OAuth tokens. Centralized OAuth/API-key/password-sign-in infrastructure for third-party services. Tokens persist via the central secrets store; auth runs on the central runtime so all worktrees share one connected state.
- Load-bearing: yes
- Web:
  - Slots:
    - `Auth.Provider`
    - `Auth.ScopeRequirement`
    - `accountsPane.Actions`
  - Slot contributors:
    - `Auth.Provider` ← `auth.apple-signing.setup-wizard`
    - `Auth.Provider` ← `auth.google`
    - `Auth.Provider` ← `auth.google-maps.setup-wizard`
    - `Auth.Provider` ← `auth.hooktheory`
    - `Auth.Provider` ← `auth.notion`
    - `Auth.ScopeRequirement` ← `backup.targets.google-drive`
    - `Auth.ScopeRequirement` ← `integrations.gmail`
    - `accountsPane.Actions` ← `primitives.pane`
  - Uses: 32 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×5
    - `infra/endpoints` ×4
    - `primitives/collapsible` ×4
    - `primitives/live-state` ×4
    - `primitives/pane` ×3
    - `config_v2/settings.configNavPane`
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/fill.Fill`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/link-gesture.activationProps`
    - `primitives/loading.Loading`
    - `primitives/overlay/imperative-dialog.openDialog`
    - `shell/notifications.toast`
    - `ui/icons.Icon`
  - Exports (types):
    - `AuthProviderContribution`
    - `AuthProviderRowProps`
    - `AuthScopeRequirement`
    - `ConnectArgs`
    - `ConnectButtonProps`
    - `ConnectResult`
  - Exports (values):
    - `accountsPane`
    - `accountsRoute`
    - `Auth`
    - `ConnectButton`
    - `currentWorktreeName`
    - `disconnect`
    - `GrantAccessButton`
    - `missingScopes`
    - `startConnectFlow`
    - `useAccountStatus`
    - `useAuthState`
- Central:
  - Uses:
    - `infra/background/timer.defineTimer`
    - `infra/secrets.getSecret`
    - `infra/secrets.ready`
    - `infra/secrets.SecretsKeychainLockedError`
    - `infra/secrets.setSecret`
    - `network/live.serveValue`
  - Exports (types):
    - `ApiKeyConfig`
    - `AuthAccountState`
    - `AuthEnvAccessor`
    - `AuthIdentity`
    - `AuthProviderDescriptor`
    - `AuthProviderKind`
    - `AuthStateValue`
    - `GetAccessTokenArgs`
    - `OAuth2Config`
    - `ParsedTokenResponse`
    - `PasswordConfig`
    - `ResolvedCredentials`
    - `TokenFailure`
    - `TokenNeedsConsent`
    - `TokenResponse`
    - `TokenSuccess`
  - Exports (values):
    - `AuthCredentialsMissingError`
    - `AuthError`
    - `AuthKeychainLockedError`
    - `AuthNeedsConsentError`
    - `AuthProviderUnknownError`
    - `authStateServed`
    - `defineAuthProvider`
    - `getAccessToken`
    - `getAccountIdentity`
    - `listProviders`
    - `registerAuthProvider`
  - Register: `defineTimer('auth.refresh')`
  - Resources: `auth-state` (push, notified)
  - Routes:
    - `GET /api/auth/start/:provider`
    - `GET /api/auth/callback/:provider`
    - `POST /api/auth/disconnect/:provider`
    - `POST /api/auth/api-key/:provider`
    - `POST /api/auth/sign-in/:provider`
    - `GET /api/auth/state`
    - `POST /api/auth/token`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
  - Exports (types):
    - `ApiKeyConfig`
    - `AuthAccountState`
    - `AuthEnvAccessor`
    - `AuthIdentity`
    - `AuthProviderDescriptor`
    - `AuthProviderKind`
    - `AuthStateValue`
    - `DisconnectBody`
    - `GetAccessTokenArgs`
    - `GetTokenBody`
    - `OAuth2Config`
    - `ParsedTokenResponse`
    - `PasswordConfig`
    - `ResolvedCredentials`
    - `SetApiKeyBody`
    - `SignInBody`
    - `TokenFailure`
    - `TokenNeedsConsent`
    - `TokenResponse`
    - `TokenSuccess`
  - Exports (values):
    - `AuthCredentialsMissingError`
    - `AuthError`
    - `AuthKeychainLockedError`
    - `AuthNeedsConsentError`
    - `AuthProviderUnknownError`
    - `authState`
    - `AuthStateValueSchema`
    - `defineAuthProvider`
    - `disconnect`
    - `DisconnectBodySchema`
    - `getAuthState`
    - `getToken`
    - `GetTokenBodySchema`
    - `oauthCallback`
    - `oauthStart`
    - `setApiKey`
    - `SetApiKeyBodySchema`
    - `signIn`
    - `SignInBodySchema`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-lg`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-xl`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-caption`
    - `ui/tokens/type-scale --font-weight-medium`
    - `ui/tokens/type-scale --font-weight-normal`
    - `ui/tokens/type-scale --line-height-caption`
  - Imported by:
    - `apps/settings/accounts`
    - `auth/apple-signing/setup-wizard`
    - `auth/google`
    - `auth/google-maps`
    - `auth/google-maps/setup-wizard`
    - `auth/google/setup-wizard`
    - `auth/hooktheory`
    - `auth/notion`
    - `backup/runs-arm`
    - `backup/targets/google-drive`
    - `integrations/gmail`
    - `integrations/google-maps`
    - `integrations/hooktheory`
  - Endpoint callers: `setup-wizard`
- Exemptions:
  - Exempts itself from: `timer/no-unlisted-timer` — `central/internal/refresh-loop.ts` (sanctioned)
- Server:
  - Exports (types):
    - `GetAccessTokenArgs`
    - `TokenFailure`
    - `TokenNeedsConsent`
    - `TokenResponse`
    - `TokenSuccess`
  - Exports (values):
    - `AuthCentralOfflineError`
    - `getTokenFromCentral`
- Sub-plugins:
  - **`apple-signing`** — Apple code-signing config registration (web). The Accounts provider row + setup wizard UI live in the setup-wizard sub-plugin. Apple code-signing credentials: config fields + certificate upload +…
    - Plugins:
      - **`setup-wizard`** — Apple code-signing UI: the Accounts 'Apple Developer' provider row plus the guided certificate + App Store Connect API key setup wizard pane.
  - **`google`** — Google OAuth provider — adds the Google row to the Accounts pane and a credentials section to Settings. Google OAuth 2.0 provider. Use with Drive, Gmail, Calendar consumer plugins via incremental…
    - Plugins:
      - **`setup-wizard`** — Interactive setup wizard for Google OAuth credentials. Replaces the Settings redirect with a guided step-by-step pane.
  - **`google-maps`** — Google Maps Platform API-key provider. The key is stored in the central auth token store (encrypted, shared across worktrees) and verified against the Places API before it is accepted.
    - Plugins:
      - **`setup-wizard`** — Guided setup pane for the Google Maps Platform API key: project → Places API → billing → key → paste. Also contributes the Accounts provider row.
  - **`hooktheory`** — Hooktheory Accounts row: signs in with a Hooktheory username and password through the shared password sign-in dialog. Hooktheory (TheoryTab) username/password provider. The password is traded once…
  - **`notion`** — Notion OAuth provider (scaffold). Adds the Notion row to the Accounts pane and a credentials section to Settings. Surfaces in Accounts pane; end-to-end smoke not yet validated.

<!-- AUTOGENERATED:END -->
