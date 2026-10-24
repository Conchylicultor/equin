# Auth meta-plugin

## Context

Future plugins (`backup-gdrive`, `gmail-client`, `notion-sync`, `anthropic-assist`, …) will need authenticated access to third-party APIs. Without shared infrastructure, each would re-implement OAuth 2.0, token storage, refresh, identity fetching, and UI. This plan introduces an `auth` meta-plugin that owns the shared machinery and a provider sub-plugin pattern so each third-party service is a thin descriptor.

Two cross-cutting constraints shape the design:

1. **Tokens are user state, not branch state.** Worktree Postgres forks diverge after creation, so tokens can't live in the per-worktree DB. They must live outside any fork.
2. **OAuth requires a stable, pre-registered `redirect_uri`.** Ephemeral worktree hostnames (`claude-xxxxx.localhost:9000`) can't be registered one-by-one. Google's OAuth 2.0 policy further constrains the shape of a loopback redirect URI: subdomains of `localhost` (including our `equin.localhost`) are rejected by Google Cloud Console with *"must end with a public top-level domain"*. Only plain `http://localhost:PORT` / `http://127.0.0.1:PORT` are accepted for Desktop-app clients.

Consequence: auth is **centralized on main**, and the registered redirect URI is `http://localhost:9000/api/auth/callback/<provider>`. Main owns the token store, the OAuth callback, and the refresh loop. Worktree server processes fetch tokens from main via a unix socket. The UI is identical everywhere thanks to the resource framework. A small gateway change makes bare `localhost:9000/api/auth/{start,callback}/*` route to the `singularity` backend.

Decisions locked in before planning:

- **Scope**: framework + a working Google provider + a Notion scaffold. Ship enough to prove the pattern end-to-end.
- **Credentials**: Settings-UI-primary. Users register their own Google Cloud OAuth client (Desktop application type) and paste **only the client ID** — no secret needed thanks to PKCE. Env-var override for developers. Shipping our own client credentials is deferred until we complete Google's app verification.
- **Provider registration**: hand-rolled `registerAuthProvider()` called at module top-level in each provider plugin. No new server-side slot primitive.

## Architecture overview

```
plugins/auth/                          core: token store, socket RPC, OAuth routes, pane, slots
├── shared/                            defineAuthProvider, types, errors
├── server/                            getAccessToken, registerAuthProvider, authStateResource, routes
├── web/                               Accounts pane, Auth.Provider slot, ConnectButton
└── plugins/
    ├── google/                        Google OAuth provider (implemented)
    └── notion/                        Notion OAuth provider (scaffold)
```

**Main vs worktree branching.** All plugin code ships identically to both. At `onReady`, the `auth` server plugin checks `process.env.SINGULARITY_WORKTREE === "singularity"` and takes one of two paths:

- **Main**: init token store (filesystem + OS keychain), start unix socket server, start refresh loop, serve `/api/auth/callback/*`.
- **Worktree**: init unix socket client. All `getAccessToken` calls proxy to main.

**Cross-worktree sync.** When main's state changes (new connection, refresh, disconnect), main fans out `POST /api/auth/invalidate` to every other worktree (discovered via `~/.singularity/worktrees/*.json`). Each worktree's handler calls `authStateResource.notify()` locally, and its WS subscribers update.

## A. Plugin barrels

### `plugins/auth/shared/index.ts`

Re-exports only — all logic in `shared/internal/lib.ts`.

```
export { defineAuthProvider } from "./internal/lib";
export type {
  AuthProviderDescriptor, AuthProviderKind,
  OAuth2Config, ApiKeyConfig,
  AuthIdentity, AuthAccountState, AuthStateValue,
  AuthEnvAccessor,
} from "./internal/lib";
export {
  AuthError, AuthNeedsConsentError, AuthMainOfflineError,
  AuthProviderUnknownError, AuthKeychainLockedError,
} from "./internal/errors";
```

No `definePlugin` export (shared has no plugin definition).

### `plugins/auth/server/index.ts`

```
import { registerAuthProvider } from "./internal/registry";
import { getAccessToken, listProviders, getAccountIdentity } from "./internal/api";
import { authStateResource } from "./internal/auth-resource";
import { authRoutes } from "./internal/routes";
import { onReady } from "./internal/boot";

export { registerAuthProvider, getAccessToken, listProviders, getAccountIdentity, authStateResource };
export { defineAuthProvider } from "@plugins/auth/shared";
export type * from "@plugins/auth/shared";

export default {
  id: "auth",
  name: "Auth",
  description: "Shared OAuth/API-key infrastructure for third-party services.",
  httpRoutes: authRoutes,
  resources: [authStateResource],
  onReady,
} satisfies ServerPluginDefinition;
```

### `plugins/auth/web/index.ts`

```
import { Shell } from "@plugins/shell/web";
import { MdKey } from "react-icons/md";
import { accountsPane } from "./panes";

export { Auth } from "./slots";
export { accountsPane };
export { ConnectButton } from "./components/connect-button";
export { useAuthState, useAccountStatus } from "./hooks";
export { authStateResource } from "./shared";

export default {
  id: "auth",
  name: "Auth",
  contributions: [
    Shell.Sidebar({
      title: "Accounts",
      icon: MdKey,
      group: "System",
      onClick: () => accountsPane.open({}),
    }),
  ],
} satisfies PluginDefinition;
```

### `plugins/auth/plugins/google/server/index.ts`

```
import { registerAuthProvider, defineAuthProvider } from "@plugins/auth/server";
import { googleDescriptor } from "./internal/descriptor";

// Top-level registration: runs on module import. By the time auth's onReady
// runs, the registry is fully populated. No ordering worries.
registerAuthProvider(googleDescriptor);

export default {
  id: "auth-google",
  name: "Auth: Google",
  description: "Google OAuth 2.0 provider (Drive, Gmail, Calendar, …).",
} satisfies ServerPluginDefinition;
```

### `plugins/auth/plugins/google/web/index.ts`

```
import { Auth } from "@plugins/auth/web";
import { GoogleRow } from "./components/google-row";
import { SiGoogle } from "react-icons/si";

export default {
  id: "auth-google-web",
  name: "Auth: Google",
  contributions: [
    Auth.Provider({
      id: "google",
      name: "Google",
      icon: SiGoogle,
      rowComponent: GoogleRow, // optional — the auth pane provides a default row
    }),
  ],
} satisfies PluginDefinition;
```

Notion scaffold is identical with TODOs in place of URLs.

## B. `defineAuthProvider`

Shape (in `plugins/auth/shared/internal/lib.ts`):

```ts
export type AuthProviderKind = "oauth2" | "apikey";

export interface AuthIdentity {
  accountId: string;        // stable per-provider user id (e.g., Google `sub`)
  email?: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface OAuth2Config {
  authorizeUrl: string;
  tokenUrl: string;
  defaultScopes: string[];
  scopeSeparator?: string;  // default " "
  pkce?: boolean;           // default true
  buildAuthorizeParams?: (ctx: {
    scopes: string[]; state: string; redirectUri: string; codeChallenge?: string;
  }) => Record<string, string>;
  parseTokenResponse?: (raw: unknown) => {
    accessToken: string; refreshToken?: string; expiresAt: number;
    scopes?: string[]; idToken?: string;
  };
  fetchIdentity: (accessToken: string) => Promise<AuthIdentity>;
  revoke?: (args: { accessToken?: string; refreshToken?: string }) => Promise<void>;
  resolveCredentials: (env: AuthEnvAccessor) => Promise<{ clientId: string; clientSecret?: string }>;
}

export interface ApiKeyConfig {
  pattern?: RegExp;
  help?: string;
  verify?: (apiKey: string) => Promise<AuthIdentity>;
}

export interface AuthProviderDescriptor {
  id: string;
  name: string;
  kind: AuthProviderKind;
  oauth?: OAuth2Config;      // required iff kind === "oauth2"
  apiKey?: ApiKeyConfig;     // required iff kind === "apikey"
}
```

`resolveCredentials` takes an env accessor rather than reading `process.env` directly so the descriptor module stays environment-agnostic and credentials are fetched lazily only on main.

## C. Provider registration

`plugins/auth/server/internal/registry.ts`:

```ts
const providers = new Map<string, AuthProviderDescriptor>();

export function registerAuthProvider(d: AuthProviderDescriptor): void {
  validateDescriptor(d);
  if (providers.has(d.id)) throw new Error(`duplicate provider: ${d.id}`);
  providers.set(d.id, d);
}

export function getProvider(id: string): AuthProviderDescriptor {
  const p = providers.get(id);
  if (!p) throw new AuthProviderUnknownError(id);
  return p;
}

export function listProviderIds(): string[] { return [...providers.keys()]; }
```

Provider plugins call `registerAuthProvider()` at **module top level** (not inside `onReady`). JS module imports complete before any `onReady` runs, so by the time auth's `onReady` executes the map is fully populated. No ordering dependency to document, no lifecycle hooks to coordinate.

Web-side, providers use the existing slot system (`Auth.Provider`). The two halves are correlated by `id`. Auth core logs a warning if a provider is contributed web-only or server-only.

## D. Token store (main only)

Files:

- `~/.singularity/auth/` — directory, mode `0700`.
- `~/.singularity/auth/tokens.json.enc` — AES-256-GCM encrypted JSON, mode `0600`.
- `~/.singularity/auth/.lock` — BSD advisory lock held by main server for its lifetime (second main instance exits fast with a clear error).

Write path: `tokens.json.enc.tmp` then `rename()` (atomic on same filesystem).

Encryption key: 32 random bytes, stored in OS keychain via `keytar` (cross-platform: macOS Keychain, libsecret on Linux, Windows Credential Manager). Service `singularity`, account `auth-store-key`. Generated on first boot on main.

File format: `version(1) || iv(12) || ciphertext || tag(16)`.

Decrypted blob shape:

```ts
interface TokenStoreBlob {
  version: 1;
  providers: {
    [providerId: string]: {
      [accountId: string]: {             // MVP: only key is "primary"
        kind: "oauth2" | "apikey";
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
      };
    };
  };
}
```

Concurrency:
- Single in-process mutex for store writes (serializes encrypt+write).
- Per-`(providerId, accountId)` promise cache `inFlight: Map<string, Promise<string>>` deduplicates concurrent refreshes.

Keychain access denial at boot: log error, start in "auth disabled" mode. `getAccessToken` throws `AuthKeychainLockedError`; Accounts pane shows an unlock banner.

## E. Unix socket RPC (main ↔ worktree)

Transport: HTTP over unix socket. `Bun.serve({ unix })` + `fetch(url, { unix })`.

Path: `~/.singularity/auth.sock`, mode `0600` (chmod after bind). Stale socket detection: if `stat()` succeeds but `connect()` fails, unlink it.

Endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/token` | `{providerId, scopes?}` → `{accessToken, expiresAt, scopes, identity}` or 409 `{needsConsent, reason, missingScopes?}` |
| `POST` | `/disconnect` | `{providerId, accountId?}` → `{ok: true}` |
| `GET` | `/status` | full `AuthStateValue` (sanitized) |
| `POST` | `/api-key` | `{providerId, apiKey}` → `{ok}` (for API-key providers) |

Authz: file mode `0600` is sufficient. Anyone who can read the socket can already read the encrypted token file; no in-band protocol.

Worktree client: retries once after 250 ms on `ECONNREFUSED`/`ENOENT` (covers main restart). Second failure throws `AuthMainOfflineError`. `authStateResource` loader catches this and returns `{mainOffline: true, providers: {}}`.

Files: `plugins/auth/server/internal/unix-rpc/{server.ts,client.ts,protocol.ts}`. Shared typed schemas in `protocol.ts`.

## F. Namespace branching

`plugins/auth/server/internal/boot.ts`:

```ts
export async function onReady() {
  if (process.env.SINGULARITY_WORKTREE === "singularity") {
    await initTokenStore();
    await startUnixSocketServer();
    startRefreshLoop();
    startFanoutWatcher();
  } else {
    initUnixSocketClient();
  }
}
```

HTTP routes registered on both, handlers branch:

| Route | On main | On worktree |
|-------|---------|-------------|
| `GET /api/auth/start/:provider` | Origin of OAuth popup flow (PKCE, state, redirect). Reached via the gateway's bare-`localhost` auth routing. | 307 → `http://localhost:9000/api/auth/start/:provider?...` (defensive; shouldn't happen in practice). |
| `GET /api/auth/callback/:provider` | Exchange code, persist tokens, fan-out, respond with postMessage HTML. Reached via bare-`localhost` auth routing. | 404. |
| `POST /api/auth/invalidate` | 204 (main is the source; doesn't need inbound). | Trigger local `authStateResource.notify()`. |
| `POST /api/auth/disconnect/:provider` | Local disconnect + fan-out. | Proxy to main via socket. |

## G. OAuth popup flow

The registered redirect URI is **`http://localhost:9000/api/auth/callback/<provider>`** — bare `localhost`, no subdomain. Google rejects any `*.localhost` redirect URI in Cloud Console with *"must end with a public top-level domain"*, and subdomain-of-loopback is unsupported for the Desktop-app client type. The gateway is extended to forward bare-`localhost` auth paths to the `singularity` backend (see section N).

Cross-origin concern: worktree page is `<worktree>.localhost:9000`, popup lands on `localhost:9000`. These are distinct origins. Solution: `window.opener.postMessage(msg, targetOrigin)` with the exact worktree origin as `targetOrigin`, plus HTTP fan-out from main as a correctness fallback.

Flow:

1. **Worktree UI** (`ConnectButton`) opens popup:
   ```
   window.open(
     `http://localhost:9000/api/auth/start/google?worktree=<name>&scopes=<csv>`,
     "singularity-auth", "width=600,height=720"
   )
   ```
   Registers a one-shot `message` listener filtering `event.origin === "http://localhost:9000"` and `event.data.type === "singularity.auth.complete"`.
2. **Main `GET /api/auth/start/:provider`** (reached via the gateway's bare-`localhost` routing):
   - Generate `nonce` (32 random bytes hex). PKCE: `codeVerifier` + `codeChallenge` (SHA-256, base64url).
   - `pendingStates.set(nonce, {providerId, worktree, scopes, codeVerifier, createdAt})` with 10-min TTL (in-memory, acceptable).
   - Build authorize URL using `descriptor.oauth.buildAuthorizeParams?.(...)` for provider quirks (Google needs `access_type=offline&prompt=consent` for refresh tokens; `code_challenge` + `code_challenge_method=S256` always set when `pkce !== false`).
   - 302 to provider.
3. **Provider** → `GET /api/auth/callback/:provider?code=...&state=...`.
4. **Main callback handler**:
   - Look up state; 400 if missing/expired.
   - POST `tokenUrl` with `code`, `code_verifier`, `client_id`, `redirect_uri`, `grant_type=authorization_code`. `client_secret` is **omitted for PKCE-only providers** (Google Desktop-app type) and included otherwise.
   - Parse via `descriptor.oauth.parseTokenResponse` (default handles standard shape).
   - `await descriptor.oauth.fetchIdentity(accessToken)`.
   - Persist under `providers[providerId].primary`.
   - `authStateResource.notify()` + `fanoutInvalidateToWorktrees()`.
   - Respond with HTML:
     ```html
     <script>
       try {
         window.opener?.postMessage(
           { type: "singularity.auth.complete", providerId, ok: true, accountId, identity },
           "http://<worktree>.localhost:9000"
         );
       } finally { window.close(); }
     </script>
     ```
5. **Worktree listener** invalidates its TanStack Query cache for `authStateResource`. The HTTP fan-out from step 4 also triggers a WS push, so correctness doesn't depend on postMessage reaching the opener.

Fallbacks:
- Popup blocked (`window.open` returns null): show a dialog with a "copy this URL" link. Fan-out ensures the pane updates when the user finishes in a normal tab.
- Popup closed without message: watchdog `setInterval` checks `popup.closed` and surfaces "Auth cancelled".

## H. Token refresh loop

`plugins/auth/server/internal/refresh-loop.ts`:

- `setInterval(tick, 60_000).unref()` on main only.
- Each tick: for every `(provider, account)` where `expiresAt < now + 5 * 60_000`, schedule `refreshToken()`.
- `refreshToken` acquires per-account promise mutex, POSTs `tokenUrl` with `grant_type=refresh_token`, updates store, `notify()` + fan-out.
- Failure handling:
  - 401 `invalid_grant` → mark `needsReconsent: true`, clear `accessToken`/`expiresAt`, keep `identity` so UI can say "Reconnect Alice's account".
  - Transient (5xx, network) → record `lastRefreshError`, leave token, retry next tick.
- `getAccessToken(providerId, scopes)`:
  1. No account or `needsReconsent` → `AuthNeedsConsentError`.
  2. Requested scopes ⊄ stored scopes → `AuthNeedsConsentError` with `reason: "missing-scopes"`.
  3. `expiresAt > now + 60_000` → return stored token.
  4. Else await `refreshToken()`; on success return; on failure throw.

## I. OAuth credentials

**MVP**: Settings-UI-primary with env-var override. **No client secret for Google** (Desktop-app + PKCE).

- Each provider plugin defines a `Config.Section` (via the existing Config plugin) titled e.g. "Google OAuth credentials". Fields for Google: **`clientId` only**. Fields for providers that require a secret (e.g. Notion Web integration): `clientId` + `clientSecret`. The section also links to the provider's setup docs.
- `resolveCredentials(env)` on main: reads Config plugin state first; falls back to env vars (`SINGULARITY_AUTH_<PROVIDER>_CLIENT_ID`, `..._CLIENT_SECRET`); throws a structured error if neither is set.
- Accounts pane shows a "Credentials not configured" state (with Setup button) instead of Connect when `resolveCredentials` throws.
- Descriptor flag `oauth.pkce = true` (default) + absence of `clientSecret` in the resolved credentials tells the callback handler to omit `client_secret` from the token exchange request. Providers that require a secret supply both in the Settings UI and the handler includes it.

**Why this shape**:
- Shipping default credentials requires Google app verification for sensitive scopes (Drive, Gmail) — weeks of review and ongoing ToS accountability we can't carry today.
- Env-only dead-ends non-dev users. Settings-UI primary lets the same flow work for devs (who can still use env) and everyone else.
- When we later obtain verified shared credentials, we add them as a compiled-in default for `resolveCredentials`. Users who already entered their own keep using them. No API break.

**Setup instructions for users (to display in the Settings link)**:
1. Go to Google Cloud Console → APIs & Services → Credentials → Create Credentials → OAuth client ID.
2. Application type: **Desktop app** (not Web application).
3. Add Authorized redirect URI: `http://localhost:9000/api/auth/callback/google`.
4. Copy the client ID into Singularity Settings → Accounts → Google. (Client secret not needed.)
5. On first Connect, Google shows an unverified-app warning for sensitive scopes — expected until we own a verified OAuth app.

## J. Accounts pane (UI)

`plugins/auth/web/panes.ts`:
```ts
export const accountsPane = Pane.define({
  id: "accounts",
  path: "/accounts",
  component: AccountsPane,
  chrome: { title: "Accounts", history: true },
});
```

`components/accounts-pane.tsx`:
- `useAuthState()` subscribes to `authStateResource`.
- `Auth.Provider.useContributions()` enumerates providers.
- For each, renders `provider.rowComponent ?? DefaultProviderRow` with `{providerId, state, onConnect, onDisconnect, onReauth}`.

`components/default-provider-row.tsx` displays:
- Icon + name.
- Status badge: `Disconnected` / `Connected` (shows email) / `Needs reconsent` (amber).
- Scopes list, collapsed by default.
- Connect / Disconnect / Reconnect button.
- Credentials-missing state with Setup link.

`components/connect-button.tsx` (exported for use outside the pane): props `{providerId, scopes?, label?}`. Opens popup, manages message listener + watchdog, surfaces results via `Shell.Toast`.

Sidebar entry: `Shell.Sidebar({ title: "Accounts", icon: MdKey, group: "System", onClick: () => accountsPane.open({}) })`.

## K. `authStateResource`

`plugins/auth/server/internal/auth-resource.ts`:

```ts
export const authStateResource = defineResource<AuthStateValue>({
  key: "auth-state",
  mode: "push",
  loader: async () => {
    if (isMain()) return loadStateFromStore();
    return fetchStateFromMain(); // unix socket GET /status
  },
});
```

Value shape:
```ts
interface AuthStateValue {
  mainOffline?: boolean;
  providers: { [providerId: string]: AuthAccountState };
}

interface AuthAccountState {
  connected: boolean;
  kind: "oauth2" | "apikey";
  credentialsConfigured: boolean;   // false → show Setup flow instead of Connect
  identity?: AuthIdentity;
  scopes?: string[];
  needsReconsent?: boolean;
  connectedAt?: number;
  lastRefreshError?: { message: string; at: number };
}
```

**Never** includes `accessToken`, `refreshToken`, `apiKey`. Safety contract: anything in this payload is broadcast to every subscribed client.

Triggers `notify()` + fan-out:
- OAuth callback success.
- Disconnect.
- Refresh success/failure.
- API key save/remove.
- Provider credentials configured (Config plugin change signal).

Cross-worktree fan-out (`internal/fanout.ts`):
- Watch `~/.singularity/worktrees/` via `fs.watch`; cache hostnames (basename minus `.json`).
- On state change: `POST http://<name>.localhost:9000/api/auth/invalidate` to each non-main worktree in parallel, errors ignored.
- Each worktree's handler calls its local `authStateResource.notify()`, which WS-pushes to all its tabs.

## L. Testing

**Unit tests** (`plugins/auth/server/__tests__/`):
- Encrypt/decrypt round trip with throwaway key; crash-safety of atomic rename.
- Refresh mutex under 10 concurrent `getAccessToken` calls → exactly one upstream request.
- `defineAuthProvider` validation: kind/config mismatch, duplicate id.
- State-machine outputs for disconnected / connected / reconsent / expired.

**Integration** (`e2e/auth/`):
- `fake-oauth-provider/`: minimal Bun server with `/authorize`, `/token`, `/userinfo`.
- Playwright: open Accounts pane → Connect → popup → assert state transitions to Connected.
- Re-consent when a new scope is requested mid-session.
- Refresh on expiry: set `expires_in=1`, wait, assert refresh observed.

**Cross-worktree** (`e2e/auth/cross-worktree.test.ts`):
- Spawn a main process (`SINGULARITY_WORKTREE=singularity`) and a worktree process (`SINGULARITY_WORKTREE=test-wt`).
- Worktree calls `getAccessToken` → asserts socket proxy works.
- Kill main → assert `AuthMainOfflineError` after retry.

## M. Gateway changes

Google's OAuth policy (and the loopback flow generally) forces the redirect URI to be bare `http://localhost:9000/...`. The gateway today returns 404 for bare `localhost` (outside `/gateway/*`). The minimal change is to route a narrow prefix to the `singularity` backend:

**File**: `gateway/proxy.go` (in `ServeHTTP` or `parseWorktree`).

**Behavior**: when the request host is bare `localhost` / `127.0.0.1` / `[::1]` (i.e. `parseWorktree(host)` returns `""`), and the path starts with `/api/auth/start/` or `/api/auth/callback/`, treat the request as if the host were `equin.localhost` and dispatch to the `singularity` backend. All other bare-localhost requests keep their existing 404.

Pseudocode sketch (not final):
```go
if worktreeName == "" {
    if strings.HasPrefix(r.URL.Path, "/api/auth/start/") ||
       strings.HasPrefix(r.URL.Path, "/api/auth/callback/") {
        worktreeName = "singularity"
    } else if strings.HasPrefix(r.URL.Path, "/gateway/") {
        // existing gateway-internal handling
    } else {
        http.Error(w, "Singularity gateway. Use <name>.localhost.", http.StatusNotFound)
        return
    }
}
```

Why scoped (auth paths only) instead of aliasing all bare `localhost` to `singularity`:
- Keeps the "use `<name>.localhost`" invariant for everything else (users who hit bare `localhost` by accident still get the helpful 404).
- Auth callbacks are the only case where a third party drives the URL and we can't control the host; everywhere else, the client chooses the hostname.
- Narrow change → small review surface, no unintended routing fanout.

Future option: broaden to alias bare `localhost` to `singularity` wholesale (nicer dev UX: visiting `localhost:9000` lands on the main app). Out of scope for this plan.

## N. Explicit deferrals

Document in `plugins/auth/CLAUDE.md`:

- **Multi-account per provider**. Schema keys accounts by `accountId` already; code paths assume `"primary"` until we add an account picker to the UI.
- **Revoke on disconnect**. `descriptor.oauth.revoke` is optional; MVP deletes locally only.
- **Rate limiting of refresh retries**. 60 s unconditional tick is fine for MVP.
- **Scope-merging UI**. Incremental scope requests currently trigger full re-consent. Google's `include_granted_scopes=true` can be enabled later via `buildAuthorizeParams`.
- **Keychain unlock UX**. If keychain is locked at boot, UI shows a banner; user unlocks out-of-band and restarts. Web-UI unlock is not MVP.
- **Shipped client credentials**. Revisit once we complete Google app verification.

## Verification

End-to-end smoke test after implementation:

1. `./equin build` in main worktree — deploys to `http://equin.localhost:9000`. Verify the gateway also routes `http://localhost:9000/api/auth/start/` to the `singularity` backend.
2. Sidebar → Accounts → initially shows "Google: Credentials not configured".
3. Click Setup → follow the Google Cloud Console instructions (Desktop-app client type, redirect URI `http://localhost:9000/api/auth/callback/google`) → paste only the client ID into Settings.
4. Back to Accounts → click Connect Google → OAuth popup opens on `http://localhost:9000/...` → complete consent → popup closes, row flips to "Connected as <email>".
5. From another worktree (e.g. current agent's): open Accounts → same Connected state appears (cross-worktree fan-out works).
6. Manually expire the stored `expiresAt` to 30 s; wait 60 s; observe refresh (check logs).
7. Click Disconnect → state flips to Disconnected on all worktrees.
8. Test consumer API from a throwaway server route: `await getAccessToken({ provider: "google", scopes: ["https://www.googleapis.com/auth/drive.readonly"] })` returns a valid token.

Acceptance for this plan = (1)–(8) pass manually on a fresh clone.

## Critical files to modify

New:

- `plugins/auth/shared/index.ts` and `shared/internal/{lib.ts,errors.ts}`
- `plugins/auth/server/index.ts` and `server/internal/`:
  - `boot.ts` — namespace branching, `onReady`
  - `registry.ts` — `registerAuthProvider` + `getProvider`
  - `api.ts` — `getAccessToken`, `listProviders`, `getAccountIdentity`
  - `token-store.ts` — encrypted file I/O, keychain, mutexes
  - `refresh-loop.ts` — background refresher
  - `routes.ts` — HTTP route map
  - `oauth-start.ts`, `oauth-callback.ts` — the flow handlers
  - `auth-resource.ts` — resource definition
  - `fanout.ts` — worktree hostname discovery + HTTP fan-out
  - `unix-rpc/{protocol.ts, server.ts, client.ts}`
- `plugins/auth/web/index.ts`, `web/slots.ts`, `web/panes.ts`, `web/hooks.ts`, and components: `accounts-pane.tsx`, `default-provider-row.tsx`, `connect-button.tsx`
- `plugins/auth/plugins/google/server/index.ts` and `server/internal/descriptor.ts`
- `plugins/auth/plugins/google/web/index.ts` and `web/components/google-row.tsx` (optional; can use default row)
- `plugins/auth/plugins/notion/{server,web}/index.ts` — scaffold only
- `plugins/auth/CLAUDE.md` — documents the main-vs-worktree model, deferrals, and the credentials product decision
- `e2e/auth/fake-oauth-provider/` and test files

Edits:

- `web/src/plugins.ts` — register `auth`, `auth-google-web`, `auth-notion-web` plugin imports
- `server/src/plugins.ts` — register `auth`, `auth-google`, `auth-notion` plugin imports (order: `auth` *after* provider modules so providers' top-level `registerAuthProvider` runs first; or `auth` first with providers registering at top-level import — either works since import resolution completes before any `onReady`)
- `gateway/proxy.go` — route `/api/auth/start/*` and `/api/auth/callback/*` on bare `localhost` to the `singularity` backend (see section M)
- `docs/plugins.md` — regenerated by the `plugins-doc-in-sync` check
- Root `package.json` — add `keytar` dependency (or equivalent) as a shared dep

No changes to `cli/` (the singularity worktree is already a standard `~/.singularity/worktrees/singularity.json` entry).
