# Secrets: instance-scoped namespaces, caller identity, write history

## Context

On 2026-11-06 main's `deploy update website` stopped with
`RESEND_API_KEY (value changed)`. Cause: the promo-film seed (worktree
`att-1792947727-5k4w8f`, namespace `promo-film.<checkout>`) writes a Deploy
fixture whose deployment carries `RESEND_API_KEY: "re_film_seeded_not_a_real_key"`
through `setAndApproveDeploySecret` → `setSecret`. Every backend's `SecretStore`
is `centralSecretStore` (`infra/secrets/machine`): ONE machine-wide store,
shared by main and every worktree, which knows nothing about its caller
(`secrets/central/internal/handlers.ts`). The fake value replaced the real key.
The approval gate held (nothing shipped), but:

1. a seed / demo fixture could write production secrets at all;
2. nothing stops any non-main namespace from overwriting main's deploy
   credentials (main's own `writeDeployFixture` already writes `deploy-ssh/<srv>`
   the same way);
3. the store keeps only the last `updatedAt`, so "who changed it" took an
   hour of forensics and is unanswerable for the earlier write.

The machine-wide store is deliberate for credentials that are the *user's*
(OAuth tokens, Claude accounts, config-field API keys): sign in once, every
worktree works. Deploy credentials are different: they belong to **main's
instance** (what main deploys), the way main's DB rows do — and a worktree
already gets a fork of main's DB, not main's DB.

## Design

### 1. Every secret namespace declares its scope (rung 2: tsc)

`infra/secrets/core` gains `defineSecretNamespace(id, { scope })` returning a
branded `SecretNamespace`; `SecretRef.namespace` becomes `SecretNamespace`, so
a write to an undeclared namespace does not compile.

- `scope: "machine"` — today's behaviour: one value for every namespace.
  `auth-tokens`, `claude-accounts`, `config-fields`.
- `scope: "instance"` — the value belongs to the instance writing it. `deploy-secrets`,
  `deploy-ssh`, `deploy-secret-grants`.

The scope travels on every request (`SecretRefBodySchema` gains `scope`),
declared once at the namespace's definition, never per call.

### 2. Caller identity + instance layers at central (items 1 and 2)

- `centralSecretStore` stamps every request with its namespace
  (`runtimeNamespace()`), in a header spelled once in `secrets/core`
  (`SECRETS_CALLER_HEADER`). It is the caller's own claim — an accident guard
  against our own code, not authentication (any local process can read the
  store's key file anyway; single-instance ADR).
- Central keeps, for `instance` namespaces, a **base layer** (main's) and one
  **overlay per caller namespace**:
  - main (`MAIN_WORKTREE_NAME`, exactly — `promo-film.<main checkout>` is not
    main) reads/writes the base;
  - any other namespace reads its overlay, falling through to the base, and
    writes/deletes only its overlay (delete = tombstone, so main's value does
    not reappear);
  - a write to an `instance` namespace with no caller header is refused (403,
    loud): the base can be written by main only.
  - `machine` namespaces are unchanged.
- So the film seed's fake key lands in `promo-film.<checkout>`'s overlay: the
  film still shows an approved secret, main's key is never touched (item 1
  needs no seed-specific code, and no seed can forget it). A worktree testing
  Set value gets its own copy, like its DB fork.
- Blob shape: `namespaces[ns][key]` stays the base; new
  `overlays[callerNamespace][ns][key]`. `version` bumped with an in-place upgrade
  (no overlays = empty).
- Overlay lifetime: entries are tiny and bounded by namespaces; reclaiming
  removed worktrees' overlays is a follow-up task (no worktree-removed hook
  exists today).

### 3. Write history (item 3)

- Each entry (base and overlay) keeps `history`: the last 20 writes
  `{ at, op: "set" | "delete", by: <caller namespace> | null, changed: boolean }`
  (`changed` = the value differs from the previous one — never a value or digest).
- `secretsMeta` / `getSecretMetadata` return `{ set, updatedAt, history }`.
- Deploy app Secrets section: each row shows its last write ("Set Nov 6, 18:45
  by promo-film.att-…"), and a `changed` row says who changed it; the
  namespace links to its attempt when it names one. Read in `planFor`
  (`approvals/server/internal/state.ts`) via `getSecretMetadata`, carried on
  `DeploySecretRow` as `lastWrite`.

## Files

- `plugins/infra/plugins/secrets/core/` — `defineSecretNamespace`, branded
  `SecretNamespace`, `SECRETS_CALLER_HEADER`, schemas (`scope`, `history`).
- `plugins/infra/plugins/secrets/central/internal/{store,handlers,api}.ts` —
  layers, refusal, history, blob upgrade.
- `plugins/infra/plugins/secrets/machine/internal/central-store.ts` — caller header.
- Namespace declarations at each owner: auth token store, claude-cli accounts,
  config-fields secret storage, deploy-secrets approvals (`state.ts`,
  `fingerprint.ts`), deploy servers (`store-ssh-key.ts`).
- `plugins/apps/plugins/deploy/plugins/deploy-secrets/plugins/approvals/{core/schemas.ts,server/internal/state.ts,web/components/secrets-section.tsx}` — `lastWrite`.
- Docs: `infra/secrets/CLAUDE.md` (scopes, layers, header), approvals `CLAUDE.md`.

## Verification

- Unit tests (central store): main writes base; worktree write lands in its
  overlay and reads back, main still reads base; worktree delete tombstones;
  no-caller write to an instance namespace refused; machine namespaces shared;
  history appends/caps, `changed` correct; blob v1 upgrades.
- `./equin test plugins/infra/plugins/secrets plugins/apps/plugins/deploy`,
  `./equin check`, `./equin build`.
- Live: from this worktree's backend, a Set value on a deploy secret leaves
  main's `deploy-secrets/RESEND_API_KEY` metadata (`updatedAt`) unchanged and
  shows "by <this worktree>" in this worktree's Secrets section.

## Not in scope

- Restoring the real `RESEND_API_KEY` — only the user has it (Set value + Approve on main).
- Authenticating callers (per-backend tokens minted by the gateway).
