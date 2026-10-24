# Deploy: provider-aware SSH setup (Hetzner first)

## Context

The deploy app's server page has a free-text "Console URL" field and a write-only
"SSH Private Key" paste field. Setting up SSH access today means the user must
generate a keypair themselves, install the public half on the server, and paste
the private half — with no guidance. This plan adds:

1. **Provider auto-detection** — when `consoleUrl` matches a known provider
   (Hetzner Cloud first), a collapsible "Set up SSH access — Hetzner" section
   appears **inline in the SSH area** of the server page (user decision: inline
   collapsible, not a separate wizard pane).
2. **Server-side keypair generation** — the primary path generates an ed25519
   keypair on the server; the private half goes straight into the secrets store
   (same `deploy-ssh` slot the paste flow uses) and is never shown. The user
   only sees the public key, baked into a copy-paste install one-liner. The
   paste-a-private-key field stays as the manual fallback.
3. **A generic provider registry** — providers are contributed via a slot
   (collection-consumer separation: the section consumes only the generic API,
   never names Hetzner). Adding a provider later = adding one sub-plugin.

Precedent: the Google/Apple auth setup wizards
(`plugins/auth/plugins/{google,apple-signing}/plugins/setup-wizard/`) both
hand-roll private `Step`/`StepLink` components. This is the third instance, so
the step UI is extracted into a shared primitive (and made prettier — the user
explicitly invited better polish than the existing wizards).

## Architecture

Three layers, one-directional (verified acyclic):

- **`servers`** (existing, lowest) — owns the record, the `deploy-ssh` secret,
  the new `ssh_public_key` column, and the new **keypair-generation endpoint**.
  Defines a new inline placement slot `Servers.SshSetup` rendered in the SSH
  area of `ServerEditForm`. Never imports ssh-setup.
- **`deploy/plugins/ssh-setup`** (new) — defines the generic `SshProvider`
  registry slot (mirrors `Auth.Provider`: `defineSlot` from web-sdk core) and
  the collapsible section that matches `consoleUrl` → provider and renders the
  provider's `Instructions`. Contributes the section into `Servers.SshSetup`.
- **`deploy/plugins/ssh-setup/plugins/hetzner`** (new leaf) — one `SshProvider`
  contribution: `match` on `console.hetzner.com` + the Hetzner instructions.
- **`primitives/plugins/setup-steps`** (new) — extracted `Steps`/`Step`/
  `StepLink` primitive.

Why a new `Servers.SshSetup` slot: the existing `Deploy.Section` slot renders
*below* the whole edit form as separate cards (`panes.tsx:99-116`); the
requirement is inline placement next to `SshKeyField`. Mirror `Deploy.Section`'s
shape (`defineRenderSlot`, children-callback render).

## Key decisions

- **Keygen mechanics**: shell out to `ssh-keygen -t ed25519 -N "" -C <comment>`
  via `spawnExpectOk` from `@plugins/infra/plugins/spawn/core` (NOT `/server` —
  that barrel re-exports nothing) into a `mkdtemp` dir, read private + `.pub`,
  `rm -rf` in `finally`. Canonical OpenSSH format (matches what the paste field
  expects and what an eventual ssh client consumes), zero new deps, no
  hand-rolled wire encoding. `/usr/bin/ssh-keygen` is present on macOS/Linux.
- **Public key persistence**: new nullable column `ssh_public_key` on
  `deploy_servers` (servers-owned — the generate endpoint already writes the
  secret and the row, so an entity-extensions side-table owned by another
  plugin would split one write across owners). The row UPDATE is what makes the
  live `deploy.servers` push resource refresh via the DB change-feed — **no
  explicit notify call exists or is needed** (the loader spreads `...r`, so the
  column flows once added to `ServerSchema`).
- **Overwrite guard**: the endpoint 409s if a key is already configured
  (`hasSecret`) unless `body.replace === true`; the UI shows "Regenerate"
  behind a confirm.
- **Provider contract** (client-side matching only):
  ```ts
  export interface SshProviderDescriptor {
    id: string;
    name: string;
    icon?: ComponentType<{ className?: string }>;
    match: (consoleUrl: URL) => boolean;
    Instructions: ComponentType<{ server: Server; publicKey: string | null }>;
  }
  export const SshProvider = defineSlot<SshProviderDescriptor>(
    "deploy.ssh-provider", { docLabel: (p) => p.name });
  ```
  A registry slot (not a render slot) because the section needs the matched
  provider's `name`/`icon` for the collapsed header, not just a render.
- **Collapse behavior**: `SectionCard` (has `title`/`actions`/`defaultOpen`),
  `defaultOpen={!server.sshKeyConfigured}` — expanded while action is needed,
  collapsed once configured. Header: provider icon + "Set up SSH access —
  <name>"; `actions`: status chip (Configured / Not set).
- **Steps primitive API**: `<Steps>` (renders `Stack as="ol"`, auto-numbers) +
  `<Step state={"upcoming"|"active"|"done"} title>` (single enum instead of the
  precedent's `active`+`done` bool pair; upcoming = dimmed + inert, done =
  green check) + `<StepLink href label?>` ("Open ↗"). Polish over precedent: a
  connecting vertical rail between step circles. Retrofitting the google/apple
  wizards onto it is a **follow-up task**, not this change.
- **Hetzner steps** (all inside `Instructions` — the flow is provider-shaped):
  1. *Generate key* — button → `POST /api/deploy/servers/:id/ssh-keypair`;
     done when `sshKeyConfigured`; "Regenerate" (confirm → `replace: true`)
     when already configured.
  2. *Open the Hetzner console* — `StepLink` to `server.consoleUrl` (the
     overview page carries the `>_` web-terminal button; no stable deep-link
     to the terminal exists).
  3. *Install the key* — CopyButton one-liner with the public key baked in:
     `mkdir -p ~/.ssh && echo '<pubkey>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`.
     Active once `publicKey` is known; no auto-done (install isn't verifiable
     remotely — a "Test connection" step needs ssh-client infra that doesn't
     exist yet; follow-up).

## New files

- `plugins/primitives/plugins/setup-steps/` — `package.json`,
  `web/internal/steps.tsx` (Steps/Step/StepLink, lifted from
  `google-setup-pane.tsx:243-300` and generalized), `web/index.ts` barrel.
- `plugins/apps/plugins/deploy/plugins/ssh-setup/` — `package.json`,
  `web/slots.ts` (SshProvider + descriptor), `web/components/ssh-setup-section.tsx`
  (generic consumer: parse `consoleUrl` — invalid/empty → render nothing;
  `SshProvider.useContributions().find(p => p.match(url))` — no match → render
  nothing; else SectionCard + `provider.Instructions`), `web/index.ts`
  (contributes `Servers.SshSetup({ order: 10, component: SshSetupSection })`,
  exports SshProvider + type).
- `plugins/apps/plugins/deploy/plugins/ssh-setup/plugins/hetzner/` —
  `package.json`, `web/components/hetzner-instructions.tsx`, `web/index.ts`
  (contributes the SshProvider descriptor, `match: (u) => u.hostname === "console.hetzner.com"`).
- `plugins/apps/plugins/deploy/plugins/servers/web/slots.ts` — `Servers.SshSetup`
  render slot: `defineRenderSlot<{ order: number; component: ComponentType<{ server: Server }> }>("deploy.servers.ssh-setup")`.
- `plugins/apps/plugins/deploy/plugins/servers/server/internal/ssh-keygen.ts` —
  `generateEd25519Keypair(comment)` helper (spawnExpectOk + tmpdir, fail-loud).
- `plugins/apps/plugins/deploy/plugins/servers/server/internal/handle-generate-keypair.ts` —
  `implement(generateSshKeypair, …)`: 404 on missing row; 409 if `hasSecret` and
  not `replace`; generate; `setSecret({namespace:"deploy-ssh",key:id}, priv)`;
  `db.update` `sshPublicKey` + `updatedAt`; return `{ publicKey }` only.

## Modified files (all under `plugins/apps/plugins/deploy/plugins/servers/`)

- `shared/schemas.ts` — add `sshPublicKey: z.string().nullable()` to ServerSchema.
- `shared/endpoints.ts` — add `GenerateKeypairBodySchema = z.object({ replace: z.boolean().optional() })`
  and `generateSshKeypair = defineEndpoint({ route: "POST /api/deploy/servers/:id/ssh-keypair", … response: z.object({ publicKey: z.string() }) })`.
- `shared/index.ts` — re-export the new endpoint + types.
- `server/internal/tables.ts` — add `sshPublicKey: text("ssh_public_key")` (nullable).
- `server/internal/handle-get.ts`, `handle-create.ts` — include `sshPublicKey`
  in the mapped response (create → `null`). `resources.ts` spreads `...r`, no change.
- `server/index.ts` — register the new route → `handleGenerateKeypair`.
- `web/index.ts` — export `Servers` (placement slot) and `generateSshKeypair`
  (own-symbol re-export, consistent with existing `serversResource`/`Server`).
- `web/components/server-edit-form.tsx` — render
  `<Servers.SshSetup.Render>{(s) => <s.component server={server} />}</Servers.SshSetup.Render>`
  above `SshKeyField`; soften the key-field hint to read as the manual fallback.

## Migration

Additive nullable column → `./equin build --migration-name deploy-ssh-public-key`
(build regenerates + applies; never run drizzle-kit manually). Commit the
generated migration.

## Verification

1. `./equin build --migration-name deploy-ssh-public-key`; then
   `./equin check` (boundaries, migrations-in-sync, type-check).
2. Open `http://att-1784801579-t4af.localhost:9000/deploy/server/srv-1784718612584-q17b8x`
   (this server already has the Hetzner console URL set).
3. Scripted Playwright (`e2e/screenshot.mjs`): `--click "Generate"` on the
   "Set up SSH access — Hetzner" section, before/after screenshots — assert the
   public key + install one-liner appear and the status chip flips to
   Configured. Reload → section renders collapsed (defaultOpen false).
4. `query_db`: `deploy_servers.ssh_public_key` populated; endpoint response
   contains only `{ publicKey }` (no private key anywhere but the secret store).
5. Negative: re-POST without `replace` → 409; with `{ replace: true }` → new key.
   Server with empty/non-Hetzner consoleUrl → no section rendered.

## Follow-ups (file as tasks, out of scope)

- Retrofit google/apple setup wizards onto `primitives/setup-steps`.
- "Test connection" step once ssh-client infra exists (status/health checks).
- Hetzner web-terminal deep-link if a stable URL pattern is found.
