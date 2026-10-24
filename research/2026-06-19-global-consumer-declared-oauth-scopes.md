# Generic consumer-declared OAuth scopes + "Grant access" flow

## Context

Backup to Google Drive fails on the Backup debug pane with:

> Google account not connected or missing Drive scope (missing-scopes)

**Root cause (a design gap, not misconfiguration):** the only way to connect Google
is the generic "Connect" button in the Accounts pane
(`plugins/auth/web/components/default-provider-row.tsx:31`), which calls
`startConnectFlow` with **no `scopes`**, so the OAuth start handler falls back to
`descriptor.oauth.defaultScopes` — just `openid email profile`
(`plugins/auth/plugins/google/shared/scopes.ts`). The backup Drive target requests
`https://www.googleapis.com/auth/drive.file` (`run-target.ts:10`), the token resolver
sees it isn't in the granted set and returns `reason: "missing-scopes"`
(`plugins/auth/central/internal/token-access.ts:148-157`). **Nothing in the UI can ever
grant `drive.file`** — reconnecting re-grants the same three defaults.

The plumbing to fix this already exists: `startConnectFlow({ scopes })` →
`?scopes=` → `oauth-start.ts` → authorize URL, and Google already sends
`include_granted_scopes=true` + `prompt=consent` + `access_type=offline`. What's
missing is (a) a registry of *which scopes the app needs from a provider* and (b) a UI
affordance to grant them.

**Intended outcome:** a generic mechanism where any consumer plugin declares the OAuth
scopes it needs from a provider, and the Accounts pane surfaces a unified "Grant access"
consent flow when a connected account is missing a needed (and active) scope. Backup
Drive becomes the first consumer.

## Design

A new **web contribution slot** `Auth.ScopeRequirement` (the `Auth.Provider` slot is the
exact model). The auth UI aggregates requirements per provider, diffs against the
live-pushed granted `scopes` (`AuthAccountState.scopes`, already in `useAccountStatus`),
and renders a "Grant access" affordance for missing scopes. Declaration lives on **web**
because consent is inherently a browser action and the surfacing UI is web — every
scope-needing consumer already ships a `web/index.ts`. No central/server changes.

**Incremental consent:** plain "Connect" stays defaults-only. The grant prompt appears
only once a feature that needs the scope is **enabled** (gated via a reactive
`useEnabled` predicate reading the consumer's own config). This avoids nagging users who
never enable Drive backup.

**Request the union, not just the missing scopes.** The OAuth callback **replaces**
stored scopes (`oauth-callback.ts:96` — `scopes: tokens.scopes ?? pending.scopes`, full
overwrite, no merge). If we requested only `[drive.file]` and Google's token response
echoed only the requested scope, we'd silently drop `openid/email/profile`. So the grant
handler requests `mergeScopes(granted, missing)` — robust and provider-agnostic.

## Implementation (file-by-file)

**1. `plugins/auth/web/scopes.ts`** (new) — pure helpers, no React/imports:
- `missingScopes(required: string[], granted: string[] | undefined): string[]`
- `mergeScopes(...lists: (string[] | undefined)[]): string[]` (order-preserving dedupe union)

**2. `plugins/auth/web/scopes.test.ts`** (new, `bun:test`) — cover: granted undefined/empty,
full subset → `[]`, partial overlap, duplicates in `required`, granted superset; `mergeScopes`
dedup/order/undefined; invariant `missingScopes(req, mergeScopes(granted, missingScopes(req, granted))) === []`.

**3. `plugins/auth/web/slots.ts`** (edit) — add to the `Auth` object:
```ts
export interface AuthScopeRequirement {
  providerId: string;
  scopes: string[];
  reason: string;            // human-readable, e.g. "Back up to Google Drive"
  useEnabled?: () => boolean; // render-time gate (reads consumer config); omit ⇒ always active
}
// on Auth:
ScopeRequirement: defineSlot<AuthScopeRequirement>("auth.scope-requirement", {
  docLabel: (r) => r.reason,
}),
```

**4. `plugins/auth/web/index.ts`** (edit) — add `AuthScopeRequirement` to the `export type`
block from `./slots`. (`Auth` is already exported.)

**5. `plugins/auth/web/components/scope-grant-notice.tsx`** (new) — keeps `DefaultProviderRow`
readable. Structure (rules-of-hooks-clean):
- `ScopeGrantNotice({ providerId, status })`: reads `Auth.ScopeRequirement.useContributions()`,
  filters to `providerId`, renders one `<RequirementNotice>` per match (keyed).
- `RequirementNotice({ requirement, status })`: branches on `requirement.useEnabled` presence
  (stable per instance) into `<GatedNotice useEnabled=...>` (calls the hook unconditionally at
  top, returns null when disabled) vs `<ActiveNotice>`.
- `ActiveNotice`: `missing = missingScopes(requirement.scopes, status.scopes)`; renders nothing
  if empty; else shows the `reason` + a "Grant access" button (busy/toast like `handleConnect`)
  → `startConnectFlow({ providerId, worktree: currentWorktreeName(), scopes: mergeScopes(status.scopes, missing) })`.
- Guard: only for `status.kind === "oauth2"` connected accounts.

**6. `plugins/auth/web/components/default-provider-row.tsx`** (edit) — in the connected,
non-credentials-missing branch, render `<ScopeGrantNotice providerId={providerId} status={status} />`
in the `meta` region (below the existing scopes `<details>`). No grant logic inlined here.

**7. `plugins/backup/plugins/google-drive/shared/scopes.ts`** (new) —
`export const GOOGLE_DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file"] as const;`
(`shared/` is importable by both web and server of this plugin — `web/index.ts` already imports
`../shared/config`).

**8. `plugins/backup/plugins/google-drive/server/internal/run-target.ts`** (edit) — replace the
local `DRIVE_SCOPE` const and `scopes: [DRIVE_SCOPE]` with `import { GOOGLE_DRIVE_SCOPES } from "../../shared/scopes"`
and `scopes: [...GOOGLE_DRIVE_SCOPES]`. Single source of truth for the scope string.

**9. `plugins/backup/plugins/google-drive/web/index.ts`** (edit) — add the requirement
contribution:
```ts
import { Auth } from "@plugins/auth/web";
import { useConfig } from "@plugins/config_v2/web";
import { GOOGLE_DRIVE_SCOPES } from "../shared/scopes";
// ...
Auth.ScopeRequirement({
  providerId: "google",
  scopes: [...GOOGLE_DRIVE_SCOPES],
  reason: "Back up to Google Drive",
  useEnabled: () => useConfig(googleDriveBackupConfig).enabled,
}),
```
New legal cross-plugin edge: `backup/google-drive/web → auth/web` (runtime barrel import).

**10. `./equin build`** — regenerates the web registry (new edge + slot) so
`plugins-registry-in-sync` passes; regenerates the affected `CLAUDE.md` reference blocks.

### No central/server changes required
`oauth-start`, `oauth-callback`, `token-access`, and the Google descriptor already do
everything needed once the client requests the union. **Optional follow-up (deferred,
out of scope):** make `oauth-callback.ts:96` merge with the existing account's stored
scopes so any future caller requesting missing-only is also safe — note in the PR, don't
do it now (touches central token storage; union-request makes it unnecessary for
correctness).

## Verification

- **Unit (automatable):** `bun test plugins/auth/web/scopes.test.ts` — the union/diff math
  that protects against the full-replace. This is the load-bearing correctness check.
- **Build/types/boundaries:** `./equin build` — confirms the new cross-plugin edge is
  legal, registry in sync, types check.
- **Manual smoke (Google consent is interactive — cannot be automated):**
  1. Connect Google (defaults only) → Accounts shows 3 scopes, **no** grant notice (Drive disabled).
  2. Enable Drive backup in Settings/Config → grant notice appears: "Back up to Google Drive".
  3. Click "Grant access" → Google consent requests Drive + prior scopes → approve.
  4. Accounts now shows **4** scopes (critical full-replace check — if it shows 1, the union
     request regressed).
  5. Backup debug pane → "Run Backup Now" → google-drive target `ok` (no `missing-scopes`).
  6. Disable Drive backup → grant notice disappears (gate works).
- **UI-only (automatable via Playwright, pre-consent):** screenshot the Accounts pane after
  enabling Drive backup to confirm the "Grant access" affordance renders.

## Critical files
- `plugins/auth/web/slots.ts`, `plugins/auth/web/index.ts`
- `plugins/auth/web/scopes.ts` (+ `.test.ts`), `plugins/auth/web/components/scope-grant-notice.tsx`
- `plugins/auth/web/components/default-provider-row.tsx`
- `plugins/backup/plugins/google-drive/shared/scopes.ts`
- `plugins/backup/plugins/google-drive/server/internal/run-target.ts`
- `plugins/backup/plugins/google-drive/web/index.ts`
- `plugins/auth/central/internal/handlers/oauth-callback.ts` (read-only confirm; optional hardening site)
