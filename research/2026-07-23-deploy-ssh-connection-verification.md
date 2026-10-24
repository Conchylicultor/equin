# Deploy: SSH connection verification ("Test connection")

## Context

`research/2026-07-23-deploy-ssh-provider-setup.md` shipped the provider-aware SSH
setup flow (generate key → open provider console → paste an `authorized_keys`
one-liner) and closed with an explicit gap, quoted from that doc:

> *no auto-done (install isn't verifiable remotely — a "Test connection" step
> needs ssh-client infra that doesn't exist yet; follow-up).*

That gap is this change. Today:

- **There is zero SSH-client capability in the repo.** The only SSH-adjacent code
  is `ssh-keygen` shelled out from
  `plugins/apps/plugins/deploy/plugins/servers/server/internal/ssh-keygen.ts`.
  Nothing can open a connection, run a remote command, or check reachability.
- **The wizard's last step can never reach `done`.** In
  `.../ssh-setup/plugins/hetzner/web/components/hetzner-instructions.tsx`, steps 2
  and 3 only ever flip `upcoming → active` once a public key exists. The user
  pastes the install command and is left with no signal that it worked.
- **`deploy_servers.status` is a column nothing ever writes.** It is set once, to
  its `"unknown"` default, at `INSERT`. `UpdateServerBodySchema` doesn't even
  accept it, so there is no code path — UI or API — that can ever change it. The
  status chip and the servers-list status filter are plumbing over a constant.

Intended outcome: the setup flow ends with a **Test connection** step that
actually opens an SSH session using the generated key, reaches a verified `done`
state, and reports a *classified, actionable* reason when it fails — and server
status becomes a real, probe-written fact instead of a column that can only ever
read "unknown".

## Approach

Three layers, one-directional (`ssh-setup → health → servers → infra/ssh`; no cycles):

1. **`plugins/infra/plugins/ssh/`** *(new primitive)* — a generic, deploy-agnostic
   SSH client. Runs one remote command against a target and returns a
   discriminated result.
2. **`plugins/apps/plugins/deploy/plugins/health/`** *(new sub-plugin)* — owns
   *reachability* as its own concern: the `deploy_servers_ext_health` side-table,
   the probe endpoint, its live resource, the status badge (contributed as a
   DataView field), and the verify-step body.
3. **`.../deploy/plugins/ssh-setup/`** *(restructured)* — takes ownership of the
   `<Steps>` flow so the **generic** first step (generate key) and **generic** last
   step (verify) exist once, and providers contribute only their install guidance.

### Why a separate `health` sub-plugin rather than more code in `servers`

`servers` is a *registry*: user-authored identity, address, credentials.
Reachability is probe-written state with a different lifecycle and a different
writer. Keeping a `status` column on `deploy_servers` while a probe owns the real
verdict would recreate exactly the two-sources-of-truth drift this task is about.
So `status` **moves out of `servers` entirely** and becomes a field the health
plugin contributes into the servers DataView — the same shape as
`tasks/plugins/task-category` contributing `category` into the tasks DataView, and
`apps/pages/plugins/starred` contributing `starred` into the Pages sidebar.

It is also the natural home for the follow-ups (a scheduled reachability sweep,
HTTP/service probes) that the umbrella's own description already promises.

### Why the system `ssh` binary rather than `ssh2`

- Mirrors the working precedent inside this very plugin: `ssh-keygen` is already
  shelled out through the wedge-proof `spawnCaptured` primitive, and it already
  materializes a private key into a `mkdtemp` scratch dir — so "the secret would
  touch disk" is not a new property.
- Zero new dependencies, no Bun-compatibility risk on a native-adjacent package.
- The same binary covers the whole future surface (`exec`, `rsync`/`scp`,
  `ssh … 'tail -f'` through `spawnPassthrough`) that deploys and log streaming need.

The cost is that failure classification comes from OpenSSH stderr strings rather
than typed error events. That is contained by making `unknown` an explicit,
first-class variant that carries the raw stderr to the UI — an unrecognized
failure is surfaced verbatim, never guessed at or swallowed.

## 1. New primitive: `plugins/infra/plugins/ssh/`

```
plugins/infra/plugins/ssh/
├── package.json
├── core/index.ts                       # web-safe: SshFailureKind + zod schema
└── server/
    ├── index.ts
    └── internal/
        ├── types.ts
        ├── classify.ts
        ├── classify.test.ts            # bun:test over real OpenSSH stderr samples
        └── run.ts
```

**`core/index.ts`** (web-importable — the UI keys remediation copy off the kind):

```ts
export const SshFailureKindSchema = z.enum([
  "dns",               // hostname does not resolve
  "unreachable",       // refused / no route / network unreachable
  "timeout",           // connect or command exceeded the deadline
  "auth",              // publickey rejected — the key is not installed for this user
  "host-key-mismatch", // the pinned host key no longer matches
  "command-failed",    // connected + authenticated; the remote command exited non-zero
  "unknown",           // unclassified — carries raw stderr, never silently absorbed
]);
export type SshFailureKind = z.infer<typeof SshFailureKindSchema>;
```

**`server/internal/types.ts`**:

```ts
export interface SshTarget {
  host: string;
  port: number;
  user: string;
  /** OpenSSH-format private key. Written 0600 into a mkdtemp dir, removed in `finally`. */
  privateKey: string;
  /**
   * Host-key policy. There is deliberately no "off": an unverified host is never
   * a successful connection. `learn` is trust-on-first-use and returns the line
   * it learned so the caller can pin it; `pinned` requires an exact match.
   */
  hostKey: { mode: "pinned"; knownHostsLine: string } | { mode: "learn" };
  /** Hard wall-clock ceiling for the whole attempt. Default 15_000. */
  timeoutMs?: number;
}

export type SshRunResult =
  | { ok: true; stdout: string; stderr: string; learnedHostKey: string | null }
  | { ok: false; kind: SshFailureKind; message: string; stderr: string; exitCode: number | null };
```

**`server/internal/run.ts`** — `sshRun(target, command: string[]): Promise<SshRunResult>`:

- `mkdtemp` scratch dir; write the private key at mode `0600`; write `known_hosts`
  (the pinned line, or empty for `learn`); `rm -rf` in `finally`.
- Invoke via `spawnCaptured` from `@plugins/infra/plugins/spawn/core`:

  ```
  ssh
    -o BatchMode=yes                    # never prompt → cannot hang on a TTY read
    -o IdentitiesOnly=yes               # ignore any other configured identity
    -o IdentityAgent=none               # ignore the host's ssh-agent  ← see note
    -o PasswordAuthentication=no
    -o GlobalKnownHostsFile=/dev/null   # the pin is ours alone
    -o UserKnownHostsFile=<scratch>/known_hosts
    -o HashKnownHosts=no                # learned line must be readable back
    -o StrictHostKeyChecking=<yes | accept-new>
    -o ConnectTimeout=<ceil(timeoutMs/1000)>
    -i <scratch>/id  -p <port>  -l <user>  <host>  --  <command…>
  ```

  > **`IdentitiesOnly=yes` + `IdentityAgent=none` are load-bearing, not hygiene.**
  > Without them the developer's own agent key could authenticate and the test
  > would pass green while proving nothing about the key we generated.

- `learn` mode reads `known_hosts` back after a successful run and returns the
  learned line as `learnedHostKey`.
- Reuse `mkdtemp`/`rm -rf`-in-`finally` verbatim from the existing
  `server/internal/ssh-keygen.ts` — same shape, same lifetime discipline.

**`server/internal/classify.ts`** — `classify(exitCode, signalCode, stderr, timedOut)`.
`ssh`'s own failures exit `255`; the remote command's exit status passes through
otherwise. Case-insensitive stderr matching:

| stderr contains | kind |
|---|---|
| `could not resolve hostname`, `name or service not known`, `nodename nor servname` | `dns` |
| `connection refused`, `no route to host`, `network is unreachable`, `host is down` | `unreachable` |
| `connection timed out`, `operation timed out`, `timed out` | `timeout` |
| `permission denied (publickey`, `too many authentication failures` | `auth` |
| `host key verification failed`, `remote host identification has changed` | `host-key-mismatch` |
| killed by our own deadline (`timedOut`) | `timeout` |
| exit `255`, none of the above | `unknown` (raw stderr attached) |
| exit ∉ {0, 255} | `command-failed` |

`classify.test.ts` pins each mapping against verbatim OpenSSH output samples — the
one part of this change that is cheap to test and expensive to get wrong.

### 1b. `timeoutMs` on the spawn primitive (small, additive)

`spawnCaptured` has no deadline today, so an `ssh` wedged mid-handshake (past TCP
connect, which is all `ConnectTimeout` bounds) would hang the HTTP request
forever. Add to `plugins/infra/plugins/spawn/core/internal/`:

- `SpawnOptions.timeoutMs?: number` — on expiry `SIGTERM` the child, `SIGKILL`
  after a short grace; clear the timer in the existing `finally`.
- `SpawnResult.timedOut: boolean` so callers branch on it explicitly rather than
  inferring from `signalCode`.

A one-shot deadline, not a polling loop. Every future caller benefits; this is the
structural fix for "a captured child process has no ceiling", not a local patch.

## 2. New sub-plugin: `plugins/apps/plugins/deploy/plugins/health/`

Mirrors `tasks/plugins/task-category` byte-for-byte in shape (ext table →
`queryResource` → contributed DataView field), and `servers` for the
`shared/`-behind-barrels layout.

```
plugins/apps/plugins/deploy/plugins/health/
├── package.json
├── shared/{index.ts, schemas.ts, endpoints.ts, resources.ts}
├── server/{index.ts, internal/{tables.ts, resource.ts, handle-check.ts, handle-forget-host-key.ts}}
└── web/{index.ts, hooks.ts, components/{status-field.tsx, server-status-badge.tsx, verify-connection.tsx}}
```

**`server/internal/tables.ts`** — via
`defineExtension` from `@plugins/infra/plugins/entity-extensions/server`
(FK `CASCADE` on server delete comes free):

```ts
export const serverHealth = defineExtension(_deployServers, "health", {
  ok: boolean("ok").notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  failureKind: text("failure_kind"),        // null when ok
  failureMessage: text("failure_message"),
  /** `deploy_servers.ssh_public_key` AS OF the check — see "verified" below. */
  checkedPublicKey: text("checked_public_key"),
  /** TOFU-pinned known_hosts line, learned on the first successful check. */
  hostKeyLine: text("host_key_line"),
});
export const _deployServersHealthExt = serverHealth.table;   // drizzle-kit discovery
```

**"Verified" is exact, with no cross-plugin write.** The step is `done` iff
`ok && checkedPublicKey === server.sshPublicKey`. Regenerating the key changes
`sshPublicKey`, the comparison fails, and the verify step drops back to `active`
automatically — health never has to be told, and `servers` never has to import
health to invalidate it. For a manually pasted key both sides are `null`, which
compares equal, so that path verifies normally too.

**`shared/resources.ts`** — `serverHealthResource`, a `queryResourceDescriptor`
keyed on `parentId`. Plain (unbounded) `queryResource` is correct here and does
**not** need the bounded working-set contract: the set is one row per registered
server, and servers are hand-registered by a human — an inherently tiny,
domain-bounded set, co-bounded with the already-unbounded `deploy.servers`
resource it sits beside. (Same justification `task-category` records for its own
`queryResource`.)

**`shared/endpoints.ts`**

- `POST /api/deploy/servers/:id/ssh-check` → the probe. Response is a
  discriminated `{ ok: true } | { ok: false, kind, message, stderr }`.
- `POST /api/deploy/servers/:id/forget-host-key` → clears `hostKeyLine`, so a
  legitimate reinstall can be re-trusted deliberately.

**`server/internal/handle-check.ts`**

1. Load the row (404 if absent) and the private key via the new
   `getServerSshPrivateKey` helper exported by `servers` (below). No key
   configured → `409`, with a message pointing at step 1.
2. `sshRun({host, port, user: sshUser, privateKey, hostKey: pinned-or-learn}, ["true"])`.
   `true` is deliberately chosen so *any* non-zero exit is an SSH-layer problem,
   removing the `255` ambiguity between "ssh failed" and "the command exited 255".
3. `serverHealth.upsert(id, { ok, checkedAt, failureKind, failureMessage,
   checkedPublicKey: row.sshPublicKey, hostKeyLine: learned ?? existing })`.
   The upsert is what fires the DB change-feed and refreshes the live resource —
   no explicit notify call, same as the keypair handler.
4. Return the discriminated result. The endpoint **never** returns the private key
   or the full ssh argv; `stderr` is OpenSSH's own diagnostic text only.

**`web/`**

- `hooks.ts` — `useServerHealthMap()` (`Map<serverId, row>` off the live resource,
  mirroring `useTaskCategoryMap`) and `useServerVerified(server): boolean`
  implementing the `ok && checkedPublicKey === server.sshPublicKey` rule.
- `components/server-status-badge.tsx` — **moved verbatim from `servers`**; status
  derived client-side: no row → `unknown`, `ok` → `online`, else → `offline`.
- `components/status-field.tsx` — a `FieldExtensionProps<Server>` render-callback
  component yielding the `status` enum `FieldDef` (`value` for filter/group,
  `cell` for the badge). Exactly the `CategoryField` shape.
- `components/verify-connection.tsx` — the verify-step body: a **Test connection**
  button, a `StepDone` success line, and per-`kind` remediation copy on failure
  (`auth` → "the key isn't installed for `<sshUser>` yet — re-run the install
  command above"; `host-key-mismatch` → the security warning plus a *Forget host
  key* action; `unknown` → the raw stderr, verbatim).
- `index.ts` — contributes `Servers.Fields({ id: "status", component: StatusField })`;
  exports `useServerVerified` and `VerifyConnectionBody` for `ssh-setup`.

## 3. Restructure `ssh-setup`: the flow owns generate + verify

Hetzner's step 1 ("Generate an SSH key") is already 100% provider-agnostic — it
names nothing Hetzner-specific. So the current factoring has every provider
re-implementing generic steps, and a verify step added the same way would be
duplicated per provider and silently omittable by the next one.

Invert it: **`ssh-setup` renders the single `<Steps>` container**, owns the generic
first and last steps, and providers contribute only their install guidance.

`web/slots.ts` — descriptor changes:

```ts
export interface SshInstallStep {
  title: string;
  /** Only ever rendered once a key exists → `publicKey` is non-null by construction. */
  Body: ComponentType<{ server: Server; publicKey: string }>;
}

export interface SshProviderDescriptor {
  id: string;
  name: string;
  icon?: ComponentType<{ className?: string }>;
  match: (consoleUrl: URL) => boolean;
  installSteps: SshInstallStep[];   // replaces `Instructions`
}
```

`web/components/ssh-setup-section.tsx`:

```tsx
<Steps>
  <Step title="Generate an SSH key" state={configured ? "done" : "active"}>
    <GenerateKeyBody server={server} />          {/* lifted from hetzner, unchanged */}
  </Step>
  {provider.installSteps.map((s) => (
    <Step key={s.title} title={s.title} state={installState}>
      <s.Body server={server} publicKey={publicKey!} />
    </Step>
  ))}
  <Step title="Verify the connection" state={verifyState}>
    <VerifyConnectionBody server={server} />     {/* from deploy/health */}
  </Step>
</Steps>
```

All `<Step>`s stay **direct children** of `<Steps>` (`Children.toArray` flattens the
`.map` array), so the primitive's existing clone-based numbering keeps working
unchanged — `setup-steps` needs no modification.

State derivation, in one place:

| step | `upcoming` | `active` | `done` |
|---|---|---|---|
| Generate | — | no key | `sshKeyConfigured` |
| Install (each) | no public key | key, not verified | verified |
| Verify | no public key | key, not verified | verified |

`plugins/hetzner/web/components/hetzner-instructions.tsx` becomes two step bodies
(`OpenConsoleBody`, `InstallKeyBody`) — its step 1 is deleted, now provided
generically. The `installCommand()` one-liner is unchanged.

## Modified files

**`.../deploy/plugins/servers/`**
- `shared/schemas.ts` — drop `status` and `ServerStatusSchema` from `ServerSchema`.
- `shared/index.ts` — drop the `ServerStatus` re-exports.
- `server/internal/tables.ts` — drop the `status` column.
- `server/internal/{resources,handle-list,handle-get,handle-create}.ts` — drop the
  `status` mapping (`resources.ts` also drops its `ServerStatus` cast).
- `server/internal/ssh-secret.ts` *(new)* + `server/index.ts` — export
  `getServerSshPrivateKey(id): Promise<{ configured: true; privateKey: string } | { configured: false }>`.
  A named dependency instead of `health` reaching into the `deploy-ssh` secret
  namespace `servers` owns by string.
- `web/slots.ts` — add
  `Fields: defineFieldExtensions<Server>("deploy.servers.fields")` to `Servers`
  (mirrors `Tasks.Fields`).
- `web/components/servers-list.tsx` — drop the inline `status` field; pass
  `fieldExtensions={Servers.Fields}` to `<DataView>`.
- `web/components/server-status-badge.tsx` — **deleted** (moved to `health`).

**`.../deploy/plugins/ssh-setup/`** — `web/slots.ts`,
`web/components/ssh-setup-section.tsx`, new `web/components/generate-key-step.tsx`.

**`.../deploy/plugins/ssh-setup/plugins/hetzner/`** —
`web/components/hetzner-instructions.tsx`, `web/index.ts`.

**`plugins/infra/plugins/spawn/core/internal/{types,spawn-captured}.ts`** —
`timeoutMs` / `timedOut`.

## Migration

Two schema changes to generate together: drop `deploy_servers.status`, add
`deploy_servers_ext_health`. Dropping `status` is safe — it has only ever held its
`"unknown"` default (no code path writes it, and `UpdateServerBodySchema` doesn't
accept it), so there is no data to preserve.

```bash
./equin build --migration-name deploy-server-health
```

Never `drizzle-kit generate` directly; commit the generated file.

## Verification

1. `./equin build --migration-name deploy-server-health && ./equin check`
   (plugin-boundaries, migrations-in-sync, plugins-doc-in-sync, type-check).
2. `bun test plugins/infra/plugins/ssh` — the stderr classifier against verbatim
   OpenSSH samples for every `SshFailureKind`.
3. **End-to-end against the real Hetzner server** already registered with a console
   URL (`deploy_servers` row `srv-1784718612584-q17b8x`, per the predecessor doc) at
   `http://att-1784824270-skfp.localhost:9000/deploy/server/<id>`: generate a key,
   run the install one-liner in the Hetzner web terminal, click **Test connection**
   → step flips to `done`, list badge flips to **Online**.
4. **Negative paths, each asserted to produce the right `kind` and the right
   remediation copy** — these are the point of the change, not an afterthought:
   - install command *not* run → `auth`
   - port set to a closed port → `unreachable`
   - host set to a bogus name → `dns`
   - host set to a black-holed IP → `timeout` (and confirm the request returns,
     proving the `spawnCaptured` deadline fires)
   - tamper with `host_key_line` in the DB → `host-key-mismatch`, and *Forget host
     key* recovers
   - **agent-leak guard:** with a working `ssh-agent` key for the same host loaded
     on the host machine, a server whose key is *not* installed must still report
     `auth` — proving `IdentitiesOnly`/`IdentityAgent=none` hold.
5. `query_db`: `select * from deploy_servers_ext_health` — one row per checked
   server, `host_key_line` populated after the first success, `checked_public_key`
   matching `deploy_servers.ssh_public_key`. Confirm no private key material
   appears in any endpoint response.
6. Regenerate the key on a verified server → the verify step returns to `active`
   and the badge leaves **Online** without any extra wiring.
7. Playwright (`bun e2e/screenshot.mjs --click "Test connection"`) for the
   before/after of the full four-stage flow.

## Follow-ups (file as tasks, out of scope)

- **Scheduled reachability sweep** — a `defineJob` schedule re-probing every
  configured server so status stays fresh without a click. This is the sanctioned
  no-push-signal exception to the no-polling rule (same shape as the mail delta
  tick), and it is what finally delivers the "health checks" the umbrella
  description already advertises.
- Retrofit the Google/Apple setup wizards onto the same generic
  generate → provider-steps → verify flow shape.
- HTTP/service probes alongside the SSH probe, now that `health` owns the concern.
- Deploy execution and log streaming over the new `infra/ssh` primitive
  (`spawnPassthrough` for streaming) — the original
  `research/2026-05-05-global-deploy-platform.md` pipeline/logs sub-plugins.
