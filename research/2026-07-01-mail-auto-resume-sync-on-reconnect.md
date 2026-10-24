# Auto-resume Mail sync after a Google reconnect

## Context

When Gmail sync hits a **terminal auth error** (401 / missing-scope / consent
expired), `mail_sync_state.status` is set to `"error"`
(`plugins/apps/plugins/mail/plugins/sync/server/internal/record-error.ts` →
`recordSyncError`). The scheduled main-only delta tick
(`sync/server/internal/tick.ts`, `mail.sync-tick`, `cron: * * * * *`)
**intentionally skips errored accounts** — it only enqueues a delta when
`status === "delta" || status === "idle"`.

Consequently, after the user **reconnects their Google account / re-grants the
Gmail scope**, nothing re-arms the sync. The account stays stuck in `"error"`
until the user manually clicks **Retry now** in the sync-status banner. We want
an automatic resume the instant consent is (re)granted.

## The load-bearing constraint (why the "obvious" design is impossible)

The task hint suggested a backend `defineTriggerEvent` subscription. **That
cannot work across this boundary.** Auth runs entirely on the **central**
runtime (`plugins/auth/central`), which has *no Postgres DB and no
jobs/events capability* — `CentralPluginDefinition` has no `register` slot, and
`defineTriggerEvent`/`defineJob` write into a *per-worktree* DB. The only signal
central emits on connect/reconsent is `authStateResource.notify()`
(`plugins/auth/central/internal/actions.ts` → `emitAuthChanged`), pushed over
`/ws/central-notifications` to **browsers only**. A worktree-runtime job (like
mail sync) has *no* subscription path to it — it can only *pull* a token via
`getTokenFromCentral` over HTTP.

Therefore the reconnect signal is **only observable in the browser**, and the
clean place to react is the web runtime — exactly where the gmail boundary
already surfaces it reactively.

## Design: a headless web bridge (push-based, zero polling)

`integrations/gmail/web` already exposes the signal we need:
`useGmailAccess(): { enabled, connected, scopesGranted, ready, loading }`
(`plugins/integrations/plugins/gmail/web/internal/use-gmail-access.ts`), where
`ready = enabled && connected && scopesGranted` is driven live by the central
auth resource. **`ready` flips `false → true` precisely when the Gmail scope is
(re)granted** — which is the *only* class of error a reconnect can fix (a
missing/revoked scope drops `scopesGranted`/`connected`, so `ready` was `false`
during the auth-error state). `api_disabled` / `resync_loop` / `unknown` errors
do *not* touch `ready`, so we correctly leave them for their own remediation.

We add one small **web-only** sub-plugin that mounts an app-wide headless
listener (via `Core.Root`, the same global-mount pattern as the toaster). On the
`ready` `false → true` edge it POSTs the **existing** kick endpoint
`POST /api/mail/sync` (`mailSyncEndpoint`, `sync/core`). The endpoint's
`handleMailSync` already does `ensureAccount()` + `kickSync(accountId)` for
`error`/`delta`/`idle` status — `kickSync` clears the error fields, resets
`resyncCount`, and re-enqueues the appropriate delta/backfill job. The
`mail_sync_state` write auto-pushes through the DB change-feed, so the
sync-status banner updates to "syncing" with no user action.

**Loop-safe & precise:** we fire only on the edge (ref-guarded), never on
mail-state changes. A failed kick re-errors the account but does *not* change
`ready`, so it never re-fires; if the scope is later revoked (`ready → false`)
the guard re-arms. This also cleanly unifies the *first-connect* path (toggle-on
→ `ready` false→true → sync starts), reducing reliance on the 60s tick.

### Boundary compliance

- Mail imports **only** `@plugins/integrations/plugins/gmail/web` (the signal)
  and `@plugins/apps/plugins/mail/plugins/sync/core` (its own endpoint) —
  **never `@plugins/auth/*`** (confirmed: `rg @plugins/auth plugins/apps/plugins/mail`
  is already zero hits, and stays zero).
- **No changes** to `auth`, `integrations/gmail`, or the sync server/tick.
- Reuses `kickSync` + `mailSyncEndpoint` verbatim — no new resume logic.

## Files

**New sub-plugin** `plugins/apps/plugins/mail/plugins/sync/plugins/auto-resume/`
(the sync plugin currently has only `core` + `server` — this is its first web
surface):

- `web/index.ts` — barrel: `export default { description, contributions: [Core.Root({ component: GmailReconnectResume })] }`.
- `web/components/gmail-reconnect-resume.tsx` — headless component (renders
  `null`):
  ```tsx
  const { ready } = useGmailAccess();                 // @plugins/integrations/plugins/gmail/web
  const resume = useEndpointMutation(mailSyncEndpoint); // @plugins/infra/plugins/endpoints/web + sync/core
  const wasReady = useRef(ready);
  useEffect(() => {
    if (ready && !wasReady.current) resume.mutate({}); // fire on the reconnect/grant edge
    wasReady.current = ready;
  }, [ready]);                                          // eslint-safe: resume identity stable
  return null;
  ```
  (Mirror the banner's `useEndpointMutation(mailSyncEndpoint)` + `.mutate({})`
  usage in `sync-status/web/components/mail-sync-banner.tsx`. Handle the promise
  per `no-floating-promises` — `resume.mutate` returns void so this is fine;
  confirm against the mutation API.)
- `package.json` — copy an existing sibling plugin's `package.json` shape.
- `CLAUDE.md` — short prose (autogen block filled by `./equin build`).

Run `./equin build` — regenerates the web registry (picks up the new
`web/index.ts`), then verify.

## Verification

1. `./equin build` — must pass checks (boundaries, plugins-registry-in-sync,
   type-check).
2. DB inspection via `query_db`: find an account and set it errored to simulate
   the stuck state — actually simulate through the real path:
   - Confirm baseline: `SELECT account_id, status, error_code FROM mail_sync_state;`
3. Scripted Playwright (`e2e/screenshot.mjs`) against
   `http://<worktree>.localhost:9000`:
   - With Gmail connected + an account forced to `status='error'` (via the
     error path or a controlled DB state on a scratch worktree), reload the app
     and confirm the banner shows the error state.
   - Trigger a `ready` false→true transition (toggle Gmail off→on in Settings,
     or reconnect) and confirm: (a) `POST /api/mail/sync` fires (network/log),
     (b) `mail_sync_state.status` leaves `error` → `delta`/`backfilling`
     (`query_db`), (c) the banner flips to "syncing" with **no manual click**.
4. Confirm no auto-kick for a *healthy already-connected* account on plain page
   reload (edge only fires on transition, not on mount) — reload with a healthy
   account and confirm no spurious `POST /api/mail/sync`.

## Known caveats / follow-ups

- **Requires ≥1 browser tab open at reconnect time.** This is inherent: the
  central reconnect signal *only* reaches browsers, and the reconnect itself is
  an in-app OAuth flow, so a tab is present by construction. The central push
  reaches *all* tabs and the listener is mounted app-wide (via `Core.Root`), so
  any open app (Settings, Home, Mail…) triggers the resume. The residual gap —
  reconnect completes while zero tabs are open, then a tab opens later (no
  `ready` edge, already-true at mount) — is backstopped by the existing manual
  **Retry now** button.
- **Multiple open tabs** each fire the kick on the shared edge; concurrent
  `POST /api/mail/sync` calls are safe (graphile job dedup keyed on `accountId`
  + idempotent `kickSync` writes). Debounce only if it proves noisy.
- Not covered by design: `api_disabled` / `resync_loop` errors (a reconnect
  doesn't fix them; they keep their existing banner remediations).
