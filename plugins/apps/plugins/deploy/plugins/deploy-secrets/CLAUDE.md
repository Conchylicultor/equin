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
| plugin | `deploy-secrets` (this one: `core/`, `server/`, `machine/`) | `deploy-secrets/approvals` |
| what | `defineDeploySecret` (declare), `readDeploySecret` (read the credential file), the host-only visibility route | values, grants, gate, Secrets section, delivery endpoint |
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
(a dev worktree is `unset`: record "not configured", never fail silently). It reads
`$CREDENTIALS_DIRECTORY/<KEY>` — see *On the box* below.

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
  longer required has no row and is not delivered — its credential is removed from the box.
- **Approve** is per row (no approve-all) and sends the fingerprint the row SHOWED: a
  value replaced in between is a 409, never approved blind.

## Enforcement — four places

1. **The gate** (`DeployGates.Gate`, owned by `deployments/server`): asked in
   `run-deploy.ts` before any leg spawns, for every verb. Anything pending → the run ends
   `needs-approval` (a shared run outcome, `runs/run-outcome`) with a message listing each
   key and its status, and `resolveIn: SECRETS_SECTION_ID` — persisted on the run, so
   every surface showing it links to the Secrets section. Nothing is converged or shipped.
2. **Delivery** (`POST /api/deploy-secrets/deployments/:id/env`): converge asks again right
   before touching the host — a value can change between gate and leg, and converge can
   run by hand — and refuses on `needs-approval`. The only response carrying values; it
   403s any request with browser fetch metadata (`Sec-Fetch-*` / `Origin`).
3. **The box script** (`converge-script.ts`, `SECRET_ENV_SH` + `SECRET_CREDENTIALS_SH`):
   the script is generated from KEYS only; the values arrive on the SSH session's
   **stdin** (never argv, never the uploaded file), are checked to be exactly the
   expected keys, and each is encrypted into a credential (below). Every line it
   prints names keys, never values.
4. **The read check** (`activate-script.ts`, ship's health gate): once the shipped
   build answers, the gate asks it — `GET /api/host-only/deploy-secrets?keys=…`,
   answered through the same `readDeploySecretKey` a consumer uses, `set`/`unset`
   per key, never a value — about every credential converge installed. One it
   cannot read fails the ship (and reverts it, like every gate failure). Approved
   and delivered is not the same as readable: the env-var delivery this replaced
   lost `RESEND_API_KEY` between systemd and the backend, and nothing noticed
   until the contact form's emails did not arrive.

## On the box: encrypted systemd credentials, never env vars

Each approved secret is `/srv/equin/<c>/credentials/<KEY>.cred` (dir 0700 root),
encrypted by `systemd-creds encrypt --with-key=host --name=<KEY>` and named by an
instance drop-in, `/etc/systemd/system/equin@<c>.service.d/deploy-secrets.conf`
(`LoadCredentialEncrypted=<KEY>:<path>`). On every start systemd decrypts them into
the service's private in-memory credentials directory and sets
`$CREDENTIALS_DIRECTORY` on the main process; that one PATH is forwarded down the
runtime tree as a host fact (`launcher/core` `RUNTIME_HOST_ENV`), and the backend
opens `<dir>/<KEY>` — through the `DeploySecretSource` host service (`server/`
declares it, `machine/` provides it: portable server code may not touch the
filesystem). Paths live in `deployments/core` `deriveInstall`
(`credentialsDir`, `credentialsDropIn`).

Why not the `EnvironmentFile` (the first design): an env var is inherited by every
process the app starts, readable in `/proc/<pid>/environ`, printed by any
environment dump — and it has to get through the runtime tree's declared-environment
filters (launcher → gateway → backend), which drop every undeclared name. A
credential is a file only the code that means to read it opens.

What the encryption buys and does not: the host key lives at
`/var/lib/systemd/credential.secret` (root-only), so a credential copied off the box
alone (a leaked file, a partial backup) is useless, but a full-disk image carries
the key with it. TPM binding would close that and is deliberately not used: the
Hetzner VMs have no TPM, and a TPM-bound credential stops decrypting after a
firmware change — a site that will not start. Nothing protects a secret from code
running as the app itself; that is the floor for any delivery.

Converge stays idempotent although encryption is randomized: an existing credential
is decrypted and compared with the approved value and left untouched when equal; a
rotated one is re-encrypted, a no-longer-required one removed (with the drop-in when
none remain), and the restart gate reads the credentials dir's and drop-in dir's
mtimes. A value never touches argv or a temp file on the box (builtins, a pipe and
a command substitution only).

## UI

The site page's Settings tab **Secrets** section (`DeploymentDetail.Section`, id
`secrets`): a DataView over the `deploy-secrets.status` live value (params
`deploymentId`; external, recomputed by a grant write, a Set value `notify()` per
deployment, and the plugin-tree watcher). Shown only when the closure needs a secret;
every Settings section starts open. While a secret waits, the site page shows the
needs-secret banner (`SiteBanner`) and a Checks row (`SiteCheck`), both revealing the
section. A held run links to it from the Deployments tab, the server's run chip and
failure notice.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: readDeploySecret(decl) reads an approved deploy secret on the box, as a set/unset state, through the DeploySecretSource host service (the machine half reads the credential systemd decrypted into the service's credentials directory). The host-only GET /api/host-only/deploy-secrets answers set/unset per named key (never a value) — what ship's health gate asks of the running app.
- Server:
  - Contributes: `host-service:deploy-secrets.source` "deploy-secrets.source"
  - Uses:
    - `apps/deploy/analytics/host-only.hostOnly`
    - `infra/endpoints.implement`
  - Exports (types):
    - `DeploySecretSourceImpl`
    - `DeploySecretValue`
  - Exports (values):
    - `DeploySecretSource`
    - `readDeploySecret`
  - Routes: `GET /api/host-only/deploy-secrets`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `packages/list-bound.cappedRecord`
  - Exports (types): `DeploySecret`
  - Exports (values):
    - `defineDeploySecret`
    - `DEPLOY_SECRET_KEY_PATTERN`
    - `deploySecretsVisibilityEndpoint`
    - `DeploySecretVisibilitySchema`
    - `MAX_VISIBILITY_KEYS`
- Cross-plugin:
  - Imported by: `apps/deploy/site-messages/intake`
- Sub-plugins:
  - **`approvals`** — Secrets section of a site's Settings (and the site page's banner while a secret waits on approval): every deploy secret its composition's closure declares as a DataView (key, requesting plugin…

<!-- AUTOGENERATED:END -->
