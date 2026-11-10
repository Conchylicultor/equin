# Deploy secrets: "Use this computer's value"

## Context

Deploy app → site → Settings → Secrets lists every `defineDeploySecret` its closure
declares; each value is pasted by hand into a password dialog, then approved. Often
the computer already holds the value (the Maps browser key and Map ID in
`~/.equin/state/google-maps/browser-config.json`). The user wants, for every deploy
secret that has a local counterpart, a "Use this computer's value" action — generic
(the Deploy app names no secret), still followed by the normal per-row approval,
showing which value would be used (masked for secrets) before it is set, the value
travelling only through the existing set-value path and never written anywhere else.
For a secret that ends up public in pages (the Maps browser key) reusing is a choice,
not a default: a short hint says a separate restricted key is advised.

## Design

### The local counterpart is a server contribution, declared by the secret's owner

`deploy-secrets/server` (box-safe, already imported by the Maps machine half) gains

```ts
DeploySecrets.LocalValue({
  secret: GOOGLE_MAPS_BROWSER_KEY,          // the DeploySecret declaration (its key)
  reveal: "masked" | "plain",               // how its preview is shown
  caution?: string,                         // a short hint shown before reuse
  read(): Promise<DeploySecretValue>,        // { kind: "set", value } | { kind: "unset" }
  watch(changed): Promise<() => void>,       // push: the Secrets rows recompute on a local change
})
```

A `defineServerContribution` token (like `DeployGates.Gate`). Why a contribution and
not a literal field of `defineDeploySecret`: the local value is read by code the
owning plugin already has (the Maps file reader + its file watcher); a literal path in
the declaration would have the approvals side re-implement each store's format. The
contributor is the owner's `machine/` half (runs only on the computer); on a box it is
collected but never read (approvals is not in a deployed closure).

Contributor: `google-maps/browser-config/machine` contributes two — the key
(`masked`, caution: "This is this computer's key. For a public site, a separate key
restricted to the site's domains is advised.") and the Map ID (`plain`) — both read
from `readBrowserConfig()` (the file, never the deploy secret) and watched with the
existing `mapsBrowserConfigWatcher`.

### Approvals side (generic)

- `DeploySecretRowSchema` gains `local`: `{ kind: "none" }` |
  `{ kind: "available", preview, fingerprint, caution: string | null, sameAsCurrent }` |
  `{ kind: "unusable", reason }` (a local value the deploy value schema refuses).
  `preview` = masked (`AIza…x1Yz`: first 4 + last 4, all `•` when short) or plain;
  `fingerprint` = the same HMAC as values. Never the value.
- `planFor` reads each required key's contribution (two contributions for one key →
  throws, loud) — pure `localState()` in `plan.ts`, tested.
- New endpoint `PUT /api/deploy-secrets/values/:key/from-local` body `{ fingerprint }`:
  re-reads the local value, 409 if its fingerprint differs from the one shown, then the
  SAME store path as Set value (`storeDeploySecretValue`, factored out of
  `handleSetValue`: `setSecret` + notify). Approval is untouched: the row turns `new`.
- `deploySecretsStatusServed.whileSubscribed` also subscribes every contribution's
  `watch`, so a local change re-renders the preview (no polling).

### UI

A third row action, "Use this computer's value" (icon `computer`), rendered only when
`local.kind === "available"` and not `sameAsCurrent`. It opens a small dialog: the key,
the preview (monospace), the caution hint when any, "Saving does not approve it", and
"Use this value". A 409 shows its message.

## Files

- `plugins/apps/plugins/deploy/plugins/deploy-secrets/server/{index.ts,internal/local-value.ts}` — the token.
- `.../deploy-secrets/plugins/approvals/core/{schemas,endpoints,index}.ts` — row `local`, endpoint.
- `.../approvals/server/internal/{plan,state,handlers,served}.ts` + `plan.test.ts`, `server/index.ts`.
- `.../approvals/web/{index.ts,components/secret-actions.tsx,components/use-local-dialog.tsx}`.
- `plugins/integrations/plugins/google-maps/plugins/browser-config/machine/{index.ts,internal/local-values.ts}`.
- CLAUDE.md of deploy-secrets and browser-config.

## Verification

- `./equin test` on approvals (plan tests: mask, local states, sameAsCurrent).
- `./equin build`, then drive the site's Settings → Secrets in the browser tools:
  the Maps key row offers the action with a masked preview + hint; using it turns the
  row `new` and Approve still required.
- Review subagent (sonnet) on `git diff $(git merge-base HEAD origin/main)`, then push.
