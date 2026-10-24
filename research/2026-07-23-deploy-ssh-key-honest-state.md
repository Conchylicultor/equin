# Deploy: honest SSH key state (fingerprint, derive-on-paste, one owner)

Successor to [`2026-07-23-deploy-ssh-provider-setup.md`](./2026-07-23-deploy-ssh-provider-setup.md),
which built the provider registry and the generate→install flow. This plan fixes
what that flow got wrong about *state*.

## Context

A user inspecting a server page could not tell whether SSH was actually set up.
Three concrete defects, all downstream of one modelling mistake:

1. **`sshKeyConfigured` means "a secret row exists", but reads as "SSH works".**
   Nothing in the app has ever dialled the server. The word "Configured" appears
   **twice** — the setup card's chip and the standalone field's hint.
2. **"Configured — paste a key manually to replace it." sits above an *empty*
   textarea.** The secret is write-only and never read back, but an empty
   textarea with a placeholder is the universal "unset" affordance. Copy and
   shape contradict each other.
3. **Pasting a key leaves `ssh_public_key` NULL**, spawning a degraded branch
   ("A key is already configured (pasted manually)…") and a step-3 install
   command rendering as `…` with nothing to copy.

The root cause is that two fields — `sshKeyConfigured: boolean` and
`sshPublicKey: string | null` — encode a 4-state product, two of whose states are
the bugs above. **Collapsing them into one nullable object that carries its own
evidence makes the bad states unrepresentable rather than merely unrendered.**
Everything else in this plan falls out of that.

Two adjacent defects found while planning and fixed here because they are in the
blast radius:

- The installed `authorized_keys` line is **unrestricted root shell from any
  address**. Free to harden now (nothing has ever connected); breaking later.
- `EndpointError` hardcodes its message to `HTTP <status>` and
  `getEndpointErrorMessage` only unwraps *object* bodies — so **every plain-text
  `HttpError` message in the repo is silently discarded**. The paste path's whole
  value is its error copy, so this must be fixed for the feature to work at all.

## Decisions (user-approved)

| Decision | Choice | Why |
|---|---|---|
| Wire schema | Collapse `sshKeyConfigured` + `sshPublicKey` → one `sshKey \| null` | Contradictory states become unrepresentable |
| `authorized_keys` prefix | `restrict,pty` | Kills port/agent/X11 forwarding (real pivot boundary) while keeping full agent capability incl. interactive shells. A PTY is *not* a privilege boundary when the key already grants root command execution |
| Stale key on regenerate | Self-cleaning install command | A fingerprint is a hash — it never appears in `authorized_keys`, so a "removal command keyed on the fingerprint" cannot exist. Folding removal into the command the user runs anyway makes stale keys structurally impossible |
| Error-message fix | Fix the primitive | Recovers information currently discarded repo-wide; the local workaround leaves the footgun for the next caller |

Also settled: the passphrase-less `-N ""` is **correct, not a shortcut** — a
passphrase for an unattended daemon would live in the same encrypted blob under
the same OS-keychain master key, so it adds no attacker cost. This gets written
into the code comment so nobody "fixes" it later.

## The core type

```ts
// plugins/apps/plugins/deploy/plugins/servers/shared/schemas.ts
export const SshKeySchema = z.object({
  algorithm: z.string(),    // "ssh-ed25519"
  fingerprint: z.string(),  // "SHA256:8yF2…" — byte-identical to `ssh-keygen -lf`
  comment: z.string(),
  publicKey: z.string(),    // the trimmed authorized_keys line, verbatim
});
// ServerSchema: sshKey: SshKeySchema.nullable()   ← replaces BOTH old fields
```

`sshKey !== null` ⟺ *we hold a private key AND know exactly which public key it
corresponds to*. It is impossible to render a status without a fingerprint,
because there is nothing to render without one. The word "Configured" disappears;
the only status word left is `No key`, which is true, and appears once.

**No DB migration** — the `ssh_public_key` column already exists and is unchanged.
Only the wire schema and its comment change.

## Steps

### 1. One shared row→wire projection

**New** `servers/server/internal/project-server.ts`:

```ts
export type ServerRow = typeof _deployServers.$inferSelect;
function buildServer(row: ServerRow, hasPrivateKey: boolean): Server;
export async function toServer(row: ServerRow): Promise<Server>;
export async function toServers(rows: ServerRow[]): Promise<Server[]>;
```

Write `buildServer` in **drift-safe** form — spread the row, destructure out only
what is transformed — so a future column reaches the wire automatically:

```ts
const { sshPublicKey, createdAt, updatedAt, status, ...rest } = row;
return { ...rest, status: status as ServerStatus,
  createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
  sshKey: sshPublicKey && hasPrivateKey ? parseSshPublicKey(sshPublicKey) : null };
```

Rewrite all five hand-rolled projections to delegate: `handle-get.ts`,
`handle-list.ts`, `handle-create.ts`, `handle-update.ts`, `resources.ts`.

**This is a perf win, not just tidiness.** `toServers` replaces N `hasSecret`
round-trips to central with **one** `listKeysInNamespace("deploy-ssh")`
(confirmed exported from `@plugins/infra/plugins/secrets/server`) plus a Set
lookup. `deploy.servers` is a push resource whose loader re-runs on every row
update, so today's projection costs N cross-process calls per refresh.

> Note in the file header: the `no-hand-rolled-entity-projection` lint rule does
> **not** fire on these sites (it only inspects `defineResource({loader})`, and
> even there the `await hasSecret(...)` value fails its purity check). This
> triplication is exactly what the rule exists to prevent and exactly what it
> cannot see. `defineEntity` is **not** applicable — both new wire fields are
> *derived* (a secrets lookup and a SHA-256), and `defineEntity` returns rows
> verbatim with no hook for a derived field.

### 2. Public-key parsing + fingerprint

**New** `servers/server/internal/ssh-public-key.ts` — `parseSshPublicKey(line):
SshKeyInfo`, throws `InvalidSshKeyError`.

Algorithm (must be byte-identical to `ssh-keygen -lf`):

1. `const [algorithm, blob, ...rest] = line.trim().split(/\s+/)`
2. `const bytes = Buffer.from(blob, "base64")`
3. **Structural validation, no allowlist:** the OpenSSH blob is length-prefixed
   fields whose first is the algorithm name. Read `bytes.readUInt32BE(0)`,
   require `4 + len <= bytes.length` and
   `bytes.subarray(4, 4+len).toString("utf8") === algorithm`. Rejects garbage and
   truncated base64 without hardcoding key types (`ssh-rsa`, `ecdsa-*`, `sk-*`
   work for free).
4. `"SHA256:" + createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")`
   — SHA-256 over the **decoded blob**, padding stripped. `createHash` from
   `node:crypto` is the repo convention (`web-artifacts/core/hash.ts`).
5. `comment = rest.join(" ")` (comments may contain spaces).

**Co-located `ssh-public-key.test.ts`** (`bun:test`): one real ed25519 line with
its known `ssh-keygen -lf` fingerprint, plus rejection cases (empty, single
token, non-base64, algorithm/blob mismatch). This is the one piece where a wrong
answer is silently plausible, so it earns a vector test.

Server-side placement is right: `createHash` is not web-safe, `crypto.subtle` is
async and awkward in render, and this plugin has no `core/`.

### 3. Derive the public key on paste, and validate

**Modify** `servers/server/internal/ssh-keygen.ts` — becomes the single owner of
"shell out to `ssh-keygen`". Add:

```ts
export type InvalidSshKeyReason =
  | "public-key-pasted" | "passphrase-protected"
  | "not-a-private-key" | "unsupported-format";
export class InvalidSshKeyError extends Error { constructor(readonly reason, message) }
export async function derivePublicKey(privateKey: string, comment: string): Promise<string>;
```

- Same mkdtemp + `rm`-in-`finally` convention as `generateEd25519Keypair`; write
  the key with `{ mode: 0o600 }`.
- `spawnCaptured(["ssh-keygen","-y","-P","","-f",keyPath])` — **`spawnCaptured`,
  not `spawnExpectOk`**: a non-zero exit is a domain outcome we classify, and
  `SpawnFailedError`'s message (argv + temp path) is not user-facing copy.
- `-P ""` makes ssh-keygen **fail instead of prompting** on an encrypted key.
  Belt and braces: `spawnCaptured` gives the child `stdin: "ignore"` when no
  `stdin` option is passed, so even a prompt hits EOF rather than wedging the
  request. Say this in a comment — it is the structural reason this can't hang.
- **Pre-check:** if the pasted text parses as a *public* key, throw
  `public-key-pasted`. Most likely user mistake; deserves an exact message.
- Classify stderr: `/incorrect passphrase/i` → `passphrase-protected`;
  `/invalid format|error in libcrypto|not a key/i` → `not-a-private-key`; else
  `unsupported-format` + stderr tail. ⚠️ Version-sensitive across OpenSSH
  releases — acceptable **only** because the fallback is still a typed error with
  a real message; misclassification degrades copy, never the failure signal.
- `ssh-keygen -y` emits no comment — append ours so the `authorized_keys` entry
  is identifiable. The comment is not part of the fingerprint (blob only), so
  this is safe.
- Rewrite the `generateEd25519Keypair` doc comment with the `-N ""` rationale
  above.

**New** `servers/server/internal/store-ssh-key.ts` — the tail both write paths share:

```ts
/** setSecret FIRST, then persist the public half. Ordering is load-bearing: if
 *  the secrets store is unreachable the column stays NULL, so the row never
 *  claims a key we don't hold. The row update also fires the change-feed push. */
export async function storeSshKey(serverId, { privateKey, publicKey }): Promise<ServerRow>;
export function assertReplaceAllowed(row: ServerRow, replace?: boolean): void;
```

`assertReplaceAllowed` keys on `row.sshPublicKey !== null`, not `hasSecret` —
cheaper, consistent with what the UI shows, and it means a legacy *unusable*
stored key no longer 409-blocks the user out of generating a working one.

### 4. Endpoints

**`shared/schemas.ts`** — `SshKeySchema` + `ServerSchema.sshKey` as above.

**`shared/endpoints.ts`**
- Delete `ServerRowSchema = ServerSchema.omit({sshKeyConfigured:true})`;
  `updateServer.response` becomes the full `ServerSchema`. (Today PATCH returns a
  *different shape* than GET — a second, quieter inconsistency in this family.)
- **Remove `sshPrivateKey` from `UpdateServerBodySchema`.** The autosave PATCH
  must not also be a validating, secret-writing, destructive operation.
- `generateSshKeypair.response` → `ServerSchema` (was `{publicKey}`), so the
  mutation returns the new fingerprint without waiting on the live-state push.
- **New** `importSshPrivateKey`: `POST /api/deploy/servers/:id/ssh-keypair/import`,
  body `{privateKey, replace?}`, response `ServerSchema`.

**New** `servers/server/internal/handle-import-keypair.ts` — `assertReplaceAllowed`
→ `derivePublicKey` (map `InvalidSshKeyError` → `HttpError(400, userMessage(err))`,
rethrow everything else) → `storeSshKey` → `toServer`.

`userMessage(reason)` lives beside `InvalidSshKeyError` and is the only place
user-facing copy exists:

- `public-key-pasted` — "That's the public half. Paste the private key — the file
  starting with `-----BEGIN OPENSSH PRIVATE KEY-----`, not the `.pub` one."
- `passphrase-protected` — "This key is passphrase-protected. Singularity
  connects unattended and has no one to type a passphrase. Paste a key made
  without one (`ssh-keygen -t ed25519 -N \"\"`), or generate one here."
- others — "`ssh-keygen` couldn't read that as a private key: `<stderr tail>`".

**Modify** `handle-generate-keypair.ts` (use `assertReplaceAllowed` + `storeSshKey`,
return `toServer`), `server/index.ts` (register the import route + the Step-8
backfill), `tables.ts` (comment only: `ssh_public_key` is non-null whenever we
hold a usable key, generated or derived).

### 5. Invert provider ownership

**The gap this closes:** `SshSetupSection` currently returns `null` when the
console URL is empty, unparsable, or matches no provider — so deleting the
standalone paste field would strand those servers with **no way to set a key at
all**. Fix by inverting ownership, per the collection-consumer rule: the
collection owns the generic flow, contributors supply internals only.

**`ssh-setup/web/slots.ts`** — `SshProviderDescriptor.Instructions` (which owned
the *entire* flow) becomes:

```ts
export interface SshConsoleProps { sshUser: string }
/** Provider-specific prose for reaching a root shell in THIS provider's console.
 *  A provider contributes NO key handling — generate/paste/fingerprint/install/
 *  regenerate belong to the collection, so they exist identically for every
 *  server, including ones with no provider at all. */
ConsoleInstructions: ComponentType<SshConsoleProps>;
```

**`ssh-setup-section.tsx`** — **always renders**. Provider match becomes optional
decoration (title, icon, console prose). Structure:

```
SectionCard  title={provider ? `Set up SSH access — ${name}` : "Set up SSH access"}
             actions={key ? <Badge mono>{fingerprint}</Badge> + <CopyButton/>
                          : <Badge variant="warning">No key</Badge>}
  Step 1 "Create an SSH key"          state={key ? "done" : "active"}
  Step 2 "Open the … console"         — rendered only if consoleUrl parses
  Step 3 "Install the public key"     state={key ? "active" : "upcoming"}
```

Composition details that are load-bearing:

- **The collection owns every `<Step>` shell**; the provider supplies only the
  body. `Steps` numbers children by `cloneElement`-ing `number`/`isLast` onto
  direct children, so letting a provider return a `<Step>` would leak that
  injected-props protocol across a plugin boundary and break numbering the first
  time someone wraps it in a fragment.
- `{consoleUrl && <Step/>}` composes correctly — `Children.toArray` drops
  `false`, so with no console URL numbering is simply 1, 2.
- `StepLink` stays generic (needs only `server.consoleUrl`), so the link renders
  whether or not a provider matched. Providers own **prose only**.
- **The fingerprint appears exactly once**, in the header `actions` — the one
  region visible both collapsed and expanded, i.e. the real status line. It
  replaces `KeyStatusChip`. Step 1 must **not** reprint it; step 3 says how to
  verify (`ssh-keygen -lf ~/.ssh/authorized_keys` "should match the fingerprint
  in this section's header") without restating the value.

**`hetzner/web/components/hetzner-instructions.tsx`** → rename
`hetzner-console.tsx`, export `HetznerConsoleInstructions`, shrink to ~12 lines
of console prose. Delete `installCommand`, the `generate()` mutation, the raw
`confirm()`, the "pasted manually" branch, and the `Steps`/`Button`/`CopyButton`/
`fetchEndpoint`/`generateSshKeypair` imports. **Hetzner's cross-plugin edges drop
to one.**

### 6. Step bodies + the install command

**New** `ssh-setup/web/internal/install-command.ts` (+ co-located test):

```
mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys \
 && sed -i.bak '/ singularity-deploy-srv-XXX$/d' ~/.ssh/authorized_keys \
 && printf '\n%s\n' 'restrict,pty ssh-ed25519 AAAA… singularity-deploy-srv-XXX' \
      >> ~/.ssh/authorized_keys \
 && chmod 600 ~/.ssh/authorized_keys
```

Every piece earns its place:

- **`restrict,pty`** — see the decision table. Comment that dropping `,pty` is
  the stricter option if a future deploy path never needs a tty, and that a
  pre-7.2 sshd rejects the whole line (2016-era; accepted).
- **`printf '\n%s\n'` not `echo`** — fixes a real latent bug: today's `echo …>>`
  splices onto the previous line if the file lacks a trailing newline, silently
  corrupting **both** entries. A leading `\n` is unconditionally safe (sshd
  ignores blank lines) and `printf` avoids `echo`'s shell-dependent backslash and
  leading-`-` handling.
- **`sed -i.bak '/ <comment>$/d'`** — self-cleaning. We own the comment
  (`singularity-deploy-<serverId>`, stable across regenerations and now applied
  to pasted keys too), so re-running install after a regenerate removes the
  previous key this app installed. `-i.bak` works on GNU **and** BSD sed. The `$`
  anchor prevents deleting a line whose comment merely *starts with* the id.
  **Guard the interpolation:** emit the `sed` clause only if the comment matches
  `/^[A-Za-z0-9_.-]+$/` — it always will, but the builder must refuse rather than
  blind-interpolate into a shell command. If it doesn't match, omit the clause
  (degrades to today's non-cleaning behavior, which is honest).

**Step 1 body** (`ssh-setup/web/components/generate-key-step.tsx`):
- No key → prose + `Generate key`.
- Key → `<StepDone>Key created — the private half stays on this machine and is
  never shown.</StepDone>` + `Replace key…`.
- Both → a `Collapsible` disclosure below, mirroring
  `plugins/ui/plugins/tweakcn/plugins/community-browser/web/components/import-by-url.tsx:84-163`.
  Trigger: "Paste an existing private key instead" / "Paste a different private
  key" — **the label states the action, so a closed disclosure can never be read
  as a status claim.** Content: textarea + an explicit **"Use this key"** button
  + inline `<Text tone="destructive">` for the error. Explicit button, **not**
  blur-autosave: this is a validating destructive operation and a blur-save has
  nowhere to report a 400.
- ⚠️ `fieldTextareaClass` lives in `servers/web/components/server-fields.tsx`,
  which is plugin-private — **not importable** from ssh-setup (R10). Accept the
  ~1-line class duplication; a `Textarea` in `css/ui-kit` is the structural fix
  and is out of scope.

**Step 3 body:** with a key → the command in a `<Fill>` + `CopyButton` (same
shape as today's lines 106-126) + the verify line. Without a key → **no code
block and no copy button at all**, just "Generate or paste a key above and a
one-line install command appears here." The `…` placeholder disappears.

**Delete** `SshKeyField` (`server-edit-form.tsx:122-166`) and its render. Reword
the `Servers.SshSetup` doc comment in `servers/web/slots.ts` (it says "rendered
just above the private-key paste field" — that field will not exist).

**New** `ssh-setup/web/components/replace-key-dialog.tsx`, modelled byte-for-byte
on `studio/…/auto-serve/web/components/confirm-reset-dialog.tsx`, opened via
`void openDialog(…)`. States all three facts:

> **Replace this server's SSH key?**
> The stored private key for `SHA256:…` is destroyed permanently — it cannot be recovered.
> Until you run the new install command on the server, this app cannot reach it. Nothing on the server changes on its own.
> The old key stays authorized until then; the new install command removes it for you.

Also convert `server-edit-form.tsx:73`'s raw `confirm()` (delete server) to
`openDialog` — it must say the stored private key is destroyed and the
`authorized_keys` line stays on the server. This is the **one** place a
standalone removal one-liner genuinely helps (no install command to ride along):
`sed -i.bak '/ singularity-deploy-<id>$/d' ~/.ssh/authorized_keys`.

### 7. Create form

**Keep** the create form's key field but route it through the same validated
path: `handle-create.ts` calls `derivePublicKey` + `storeSshKey` and maps
`InvalidSshKeyError` → 400. Hint becomes "Optional. Must have no passphrase. You
can also generate one after adding the server." Surface the 400 inline (the
submit currently has **no** error path). Rationale: the create page has one SSH
affordance and no contradicting copy, so it isn't part of the reported bug — but
once it shares the import path it stops being a second, unvalidated write path,
which is the actual defect.

### 8. Backfill existing rows

**New** `servers/server/internal/backfill-ssh-public-keys.ts`, modelled on
`plugins/conversations/plugins/agents/server/internal/backfill-svg.ts`, called
from `servers/server/index.ts` `onReady`. Query rows `WHERE ssh_public_key IS
NULL`, skip those with no secret, derive + `storeSshKey` for the rest, and catch
**only** `InvalidSshKeyError` (log and continue; rethrow everything else).

**Eager, not lazy** — the derived value must be present the *first* time the page
renders, or precisely the users who have the problem (a pasted key with NULL
`ssh_public_key`) see "No key" until they touch something, reintroducing the
confusion this change exists to remove. The table is a handful of hand-added
rows; the `isNull` guard makes every later boot a zero-row no-op.
`defineJob`+`defineWarmup` would be more code than the work it schedules. Boot
safety is already handled: `runGraphPhase` logs and continues for non-load-bearing
plugins in `onReady` (`server-core/bin/index.ts:386-389`), so a central outage
logs loudly and retries next boot.

**Unusable legacy keys** (passphrase-protected/garbage from a pre-change
unvalidated paste) keep a NULL column → UI shows `No key`. That is honest: the
app cannot use them, and `assertReplaceAllowed` keying on the column means the
user can now Generate over them without a 409.

### 9. Fix the discarded-error-message primitive

`plugins/infra/plugins/endpoints/web/internal/fetch-endpoint.ts`, in
`getEndpointErrorMessage`, before the object branch:

```ts
if (typeof body === "string" && body.trim()) return body;
```

`HttpError` serializes as `new Response(err.message)` (plain text) and
`fetchEndpoint` falls back to `res.text()`, so `EndpointError.body` is a string —
but only object bodies are unwrapped, and `EndpointError`'s own message is
hardcoded to `` `HTTP ${status}` `` (`fetch-endpoint.ts:10`). Three strictly
additive lines that recover information currently thrown away for **every**
`HttpError` in the repo, including the global mutation-error toast.

⚠️ Load-bearing primitive, ~30 consumers. Strictly additive (a previously-useless
`"HTTP 400"` becomes the real message), but re-run the full check suite.

## Suggested order

1 (projection) → 2 (fingerprint + test) → 3 (derive/validate) → 4 (endpoints).
The server is coherent and typed at that point, and steps 5–7 become
compile-error-driven UI work. 8 lands with 4; 9 is independent.

## Boundary review

- **No new cross-plugin edges.** `ssh-setup → servers/web` and `hetzner →
  ssh-setup` already exist; hetzner's edges *shrink*. `ssh-setup` gains only
  primitives (`imperative-dialog`, `collapsible`, `css/badge`,
  `copy-to-clipboard`, `css/ui-kit`) — all leaves, no cycle.
- **No cycle risk:** `servers/web` never imports `ssh-setup`; it renders its own
  `Servers.SshSetup` slot, which is the inversion point.
- **Barrel purity:** add `importSshPrivateKey` / `SshKey` / `SshKeySchema` to
  `servers/web/index.ts`'s existing `export { … } from "../shared"` — the plugin
  re-exporting its **own** `shared/` symbols (as `generateSshKeypair` already
  does), not a cross-plugin re-export.
- **`shared/` stays private:** ssh-setup imports `SshKey` from
  `@plugins/apps/plugins/deploy/plugins/servers/web`, never from `…/servers/shared` (R10).
- **No migration.** If `migrations-in-sync` goes red, something changed in
  `tables.ts` that shouldn't have.
- **Docs:** update the hand-written prose in `ssh-setup/CLAUDE.md` to state the
  new ownership split (collection owns the flow, providers own console prose) —
  the rule a future contributor is most likely to violate. `./equin build`
  regenerates the autogen blocks.

## Verification

```bash
./equin build
./equin check
bun test plugins/apps/plugins/deploy/plugins/servers/server/internal/ssh-public-key.test.ts
bun test plugins/apps/plugins/deploy/plugins/ssh-setup/web/internal/install-command.test.ts
```

**Fingerprint correctness (the one silently-plausible failure):**
```bash
ssh-keygen -t ed25519 -f /tmp/vk -N "" -C test && ssh-keygen -lf /tmp/vk.pub
```
must match the `SHA256:…` the UI renders for the same key, byte for byte.

**End-to-end, at `http://<worktree>.localhost:9000/deploy/server/<id>`:**

1. Server with **no console URL** → the SSH card still renders (steps 1 and 3, no
   console step). This is the regression the old code had.
2. **Generate** → fingerprint appears once in the card header; step 3 shows a
   copyable command containing `restrict,pty` and the `sed` cleanup.
3. **Paste a `.pub` file** → 400 with "That's the public half…" *rendered in the
   UI* (proves step 9).
4. **Paste a passphrase-protected key** (`ssh-keygen -t ed25519 -N hunter2 -f /tmp/pk`)
   → 400 with the passphrase message. Previously this "succeeded" silently.
5. **Paste a valid passphrase-less key** → fingerprint appears and matches
   `ssh-keygen -lf /tmp/pk.pub`; step 3 offers a real install command (the old
   "pasted manually" dead end).
6. **Regenerate** → dialog names the outgoing fingerprint and all three
   consequences; new fingerprint replaces the old; install command's `sed` clause
   targets the same stable comment.
7. **Backfill:** before deploying, confirm a legacy row exists
   (`query_db`: `SELECT id FROM deploy_servers WHERE ssh_public_key IS NULL`);
   after restart it should be populated for every id present in the `deploy-ssh`
   secrets namespace.

**Install command against a real box** (the only test that proves the shell
one-liner): paste it into a Hetzner web terminal, then confirm
`ssh-keygen -lf ~/.ssh/authorized_keys` lists the fingerprint the UI shows, and
that running it a second time leaves exactly **one** `singularity-deploy-<id>`
line.

## Explicitly out of scope

The honest **"Verified"** state — actually dialling the server to prove the key
works — needs an SSH client, which the repo does not have (`ssh-keygen.ts` is the
only SSH-adjacent code anywhere). Filed as a follow-up task. Until it lands the
UI claims only what it can prove: *we hold this key*, identified by fingerprint —
never *it works*.

> **Landed in parallel.** That follow-up shipped independently as
> [`2026-07-23-deploy-ssh-connection-verification.md`](./2026-07-23-deploy-ssh-connection-verification.md)
> (the `infra/ssh` primitive + the `deploy/health` sub-plugin) and the two were
> reconciled when this branch rebased. The split holds exactly as written above:
> `servers` owns *possession* (`sshKey`, the fingerprint in the card header),
> `health` owns *reachability* (the probe verdict, the final "Verify the
> connection" step, and the `status` field it contributes back into the servers
> DataView). `deploy_servers.status` — a column nothing ever wrote — is gone with
> it, so `ServerStatus`/`ServerStatusSchema` are no longer part of this plugin's
> wire schema.
