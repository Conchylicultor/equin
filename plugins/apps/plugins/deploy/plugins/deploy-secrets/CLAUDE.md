# deploy-secrets

Credentials a **deployed** composition needs on its box, delivered only with the
user's explicit approval. Design: `research/2026-10-24-global-website-contact-form.md`
§1; the ADR's §What goes in `env`
(`research/2026-07-29-global-composition-production-deployment.md`).

**The rule:** no secret reaches a remote server unless the user approved exactly that
value for exactly that deployment. A new key, or a changed value of an approved one,
BLOCKS the deploy (`needs-approval`) until approved. Removing one needs no approval.

## Two halves, two closures

| | ships on the box | local only |
|---|---|---|
| plugin | `deploy-secrets` (this one: `core/`, `server/`) | `deploy-secrets/approvals` |
| what | `defineDeploySecret` (declare), `readDeploySecret` (read `process.env`) | values, grants, gate, Secrets section, delivery endpoint |
| imports | nothing heavy — box-safe | `infra/secrets`, `deployments/server`, the plugin tree |

The split is load-bearing: a box-side consumer imports this plugin, so it must never
drag `infra/secrets` (converge refuses a closure containing it) or the deploy UI into a
deployed closure. Everything that touches values lives in `approvals`.

## Declaring a secret (the consumer convention)

In a file under the consumer plugin's **`core/`** (any depth, not a test file):

```ts
import { defineDeploySecret } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/core";

export const RESEND_API_KEY = defineDeploySecret({
  key: "RESEND_API_KEY",                       // static string literal, [A-Z][A-Z0-9_]*
  description: "Sends the contact form's notification emails.", // static string literal
});
```

and on the box: `readDeploySecret(RESEND_API_KEY)` → `{ kind: "set", value } | { kind: "unset" }`
(a dev worktree is `unset`: record "not configured", never fail silently).

- **Discovery is a facet, not an import.** `plugin-meta/facets/deploy-secrets` statically
  reads every `defineDeploySecret({…})` call in a plugin's `core/`; the deploy side
  resolves the composition's closure (`resolveComposition`, the same one converge's guards
  use) and collects the facet over its members. It names no consumer, so a second plugin
  needing a secret is a declaration and nothing else.
- **Both fields must be literals.** The facet reads source, so `defineDeploySecret(spec)`
  or a computed key **throws** (fails the plugin-tree build, naming file:line) — a
  declaration the reader cannot see would be a secret the deploy never asks about.
- Two plugins may declare the same key: one row, one value, both named.

## The approval model (`approvals`)

- **Values**: the local secrets store, namespace `deploy-secrets`, key = the env var. One
  value per key, shared by every deployment. Entered from the Secrets section (Set value,
  a password dialog). Write-only from the UI: it is never sent back to a browser.
- **Grants**: `deploy_secret_grants (deployment_id, key) → value_fingerprint, approved_at`.
  `value_fingerprint = HMAC-SHA256(local key, key ‖ NUL ‖ value)`; the local key is
  32 random bytes minted on first use in the store (`deploy-secret-grants/hmac-v1`). The
  table never holds a value, and a rotated value is just a fingerprint no grant names.
- **Status per required key** (`diffSecrets`, pure): `missing-value` (no value),
  `new` (no grant), `changed` (grant ≠ current fingerprint), `approved`. A granted key no
  longer required has no row and is not delivered — dropped from the box's env.
- **Approve** is per row (no approve-all) and sends the fingerprint the row SHOWED: a
  value replaced in between is a 409, never approved blind.

## Enforcement — three places, same diff

1. **The gate** (`DeployGates.Gate`, owned by `deployments/server`): asked in
   `run-deploy.ts` before any leg spawns, for every verb. Anything pending → the run ends
   `needs-approval` (a shared run outcome, `runs/run-outcome`) with a message listing each
   key and its status, and `resolveIn: SECRETS_SECTION_ID` — persisted on the run, so
   every surface showing it links to the Secrets section. Nothing is converged or shipped.
2. **Delivery** (`POST /api/deploy-secrets/deployments/:id/env`): converge asks again right
   before touching the host — a value can change between gate and leg, and converge can
   run by hand — and refuses on `needs-approval`. The only response carrying values; it
   403s any request with browser fetch metadata (`Sec-Fetch-*` / `Origin`).
3. **The box script** (`converge-script.ts`, `SECRET_ENV_SH`): the script is generated
   from KEYS only; the values arrive on the SSH session's **stdin** (never argv, never
   the uploaded file), are checked to be exactly the expected keys, and are written into
   the 0600 `root:svc-<c>` env file beside `SINGULARITY_LISTEN`. Every line it prints
   names keys, never values. systemd re-reads `EnvironmentFile` on the restart the env
   change triggers.

## UI

The deployment pane's **Secrets** section (`DeploymentDetail.Section`, id `secrets`):
a DataView over the `deploy-secrets.status` live value (params `deploymentId`; external,
recomputed by a grant write, a Set value `notify()` per deployment, and the plugin-tree
watcher). Shown only when the closure needs a secret; open by default while one waits
(`"pending"` until the rows load — the section primitive latches it once known). A held
run links to it from the Deploy section, History, the server's run chip and failure
notice.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: readDeploySecret(decl) reads an approved deploy secret from the box's environment, as a set/unset state.
- Cross-plugin:
  - Imported by: `apps/deploy/site-messages/intake`
- Server:
  - Exports (types): `DeploySecretValue`
  - Exports (values): `readDeploySecret`
- Core:
  - Exports (types): `DeploySecret`
  - Exports (values):
    - `defineDeploySecret`
    - `DEPLOY_SECRET_KEY_PATTERN`
- Sub-plugins:
  - **`approvals`** — Secrets section of a deployment's page: every deploy secret its composition's closure declares as a DataView (key, requesting plugin, description, status approved / new / value changed / missing…

<!-- AUTOGENERATED:END -->
