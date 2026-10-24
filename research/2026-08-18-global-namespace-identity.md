# Namespace identity — one owner of `<composition>.<checkout>`

Phase 3 of
[`2026-08-17-global-composition-build-serve-model.md`](./2026-08-17-global-composition-build-serve-model.md).

## Context

A namespace is the name in `http://<name>.localhost:9000`, the directory under
`~/.singularity/worktrees/<name>/`, the socket `<name>.sock`, the Postgres
database, the config dir, and `SINGULARITY_WORKTREE`. Today it is a single flat
label, and it means two different things depending on who wrote it: a checkout
(`att-XXX`) or a composition (`sonata`).

Two problems.

**The gateway cannot serve a two-label name.** `parseWorktree`
(`gateway/proxy.go:473`) returns `""` the moment the subdomain contains a dot,
and `nameRegex` (`gateway/registry.go:21`) excludes `.` from the charset. So
`sonata.att-XXX.localhost:9000` 404s, and a composition can only ever be served
from main.

**Nothing owns what a namespace is called.** The inventory found:

- 4 independent copies of the `basename(root)` derivation
  (`cli/bin/commands/build.ts:790`, `e2e-harness/e2e/target.ts:38`,
  `test/bun-preload.ts:26`, and `checkoutWorktreeName` itself).
- 5 different browser-side host parsers, no two alike. `auth/web/connect.ts:100`
  takes `host.split(".")[0]`; `debug/logs`'s copy explicitly *rejects* a dotted
  name; the worktree switcher and the task-draft form each re-derive it again.
- ~25 hand-written `http://${name}.localhost:9000` strings across CLI, server,
  and web.
- 3 copies of the name regex — the Go one, `COMPOSITION_NAME_RE`, and an inline
  copy in `framework/server-core/bin/select-registry.ts:35` carrying a
  `KEEP IN SYNC` comment.

The target naming is `<composition>.<checkout>`, with the `singularity`
composition prefix and the main-checkout suffix elided so every URL in use today
keeps working:

| composition | checkout | namespace |
|---|---|---|
| singularity | main | `singularity` |
| sonata | main | `sonata` |
| singularity | att-XXX | `att-XXX` |
| sonata | att-XXX | `sonata.att-XXX` |

**The intended outcome of this phase:** the gateway can serve a two-label
namespace, and there is exactly one function that mints a namespace, one that
builds its URL, one that reads it back off a browser host, and one grammar —
each with a check or a type standing behind it. Nothing yet *produces* a dotted
name; Phase 4 is the first caller. That keeps this phase a pure
capability-plus-consolidation change with no behavioral diff.

### Browser resolution — verified, not a constraint

Checked before designing, since it was the one piece outside our control.
Chromium reaches the gateway at `sonata.att-….localhost:9000` and at
`a.b.c.localhost:9000` — it returns the gateway's own
`Singularity gateway. Use <name>.localhost.` body, i.e. DNS resolved and only
`parseWorktree` refused. macOS's system resolver (the CFNetwork path Safari
uses) maps `*.localhost` at any depth to loopback: both `ping sonata.foo.localhost`
and `curl http://a.b.c.localhost:9000` reach `::1`. Chrome and Safari are the two
browsers installed on this machine. No design change needed.

---

## The rule

### Elision, and why the ambiguity is inherent

Single-label namespaces are ambiguous: `foo` could be composition `foo` on main,
or `singularity` on checkout `foo`. This is not an artifact of a bad encoding —
it is forced. Eliding only the composition prefix breaks `att-XXX.localhost`;
eliding only the checkout suffix breaks nothing today but is the same set union
from the other side. Any scheme that preserves both of today's URL shapes maps
two different pairs onto one label. So the ambiguity must be *prevented*, not
decoded.

### Symmetric refusal

The collision is not merely an ambiguous URL. Both claimants would resolve to the
same `~/.singularity/worktrees/<name>/` directory, the same socket, and the same
database. It is a data collision, so the answer is not a precedence winner but a
refusal: **whichever side tries to claim an already-occupied namespace fails
loudly, composition or checkout.**

This generalizes the guard that already exists rather than reversing it.
`namespaceCollision` (`plugins/infra/plugins/worktree/server/internal/composition-namespace.ts:39`)
today refuses to provision a composition namespace when a git worktree dir or
branch of that name exists, or when the spec dir exists without a
`composition.json` marker. What is missing is the mirror: worktree creation does
not consult the composition manifest. Add that arm, and the guard becomes one
symmetric function both sides call.

### No inverse — record the pair, never parse it

Deliberately **no `parseNamespace`**. Decomposing `foo` back into
`(composition, checkout)` needs the composition set, which makes every reader
depend on config it may not have. Instead the pair is *recorded where the
namespace is minted*: the `composition.json` marker already stores
`composition`, and gains `checkout`. "Which composition is this namespace?" is
answered from provenance on disk, which cannot be ambiguous, rather than from
the name, which can. This is what keeps the elision harmless downstream.

---

## Design

### 1. New plugin: `plugins/infra/plugins/namespace/`

Core-only, zero imports — mirroring `plugins/framework/plugins/plugin-id/`
(which is the same shape: a branded identity plus its derived encodings, in a
`core/` a build tool, the server, and the browser can all reach). Placed under
`infra/` as a sibling of `paths` and `worktree` because both import it and it
belongs to neither.

`core/namespace.ts` exports:

```ts
/** A gateway namespace: subdomain, spec-dir basename, socket stem, DB name. */
export type Namespace = string & { readonly __brand: "Namespace" };

/** Which checkout a namespace is served from. `main` carries no suffix. */
export type CheckoutRef = { kind: "main" } | { kind: "worktree"; name: string };

export const MAIN_COMPOSITION_ID = "singularity";          // moved here (below)
export const NAMESPACE_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const NAMESPACE_RE = /^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62})?$/;

export function namespaceFor(composition: string, checkout: CheckoutRef): Namespace;
export function asNamespace(raw: string): Namespace;   // validating cast at a boundary
export function namespaceFromHost(host: string): Namespace | null;  // browser + gateway mirror
export function namespaceUrl(ns: Namespace, path?: string): string;
export function namespaceHost(ns: Namespace): string;
```

`CheckoutRef` is a discriminated union rather than a nullable string on purpose:
the main checkout's directory basename happens to *be* `singularity`, so a plain
`checkout: string` lets a caller pass `"singularity"` and silently mint
`sonata.singularity`. With the union that spelling does not exist. The union is
minted by `checkoutRef(root)` in `paths/server` (below), which compares against
`getMainRepoRoot()` — the only place that comparison should be made.

`namespaceFor` elides both sentinels and is total:

| composition | checkout | result |
|---|---|---|
| `singularity` | `{kind:"main"}` | `singularity` |
| `singularity` | `{kind:"worktree", name:"att-X"}` | `att-X` |
| `sonata` | `{kind:"main"}` | `sonata` |
| `sonata` | `{kind:"worktree", name:"att-X"}` | `sonata.att-X` |

`NAMESPACE_RE` caps at two labels — the model has exactly two axes, so a third
label is not a thing that can be meant. A property test pins that every
`namespaceFor` output matches it.

### 2. `MAIN_COMPOSITION_ID` moves here

It currently lives in `plugin-meta/plugins/composition/core/namespace.ts`, whose
docblock makes a point of that file having zero imports so every runtime can
reach it. `namespaceFor` needs the constant, and `infra → plugin-meta` is the
wrong direction, so the constant moves down into the new zero-import leaf and
`composition/core/namespace.ts` imports it. Reachability is preserved because
the leaf it now imports is itself zero-import. `RESERVED_COMPOSITION_NAMESPACES`,
`assertCompositionId` and the rest stay where they are — they are composition
vocabulary, not namespace vocabulary.

`paths/core` likewise imports it and defines
`MAIN_WORKTREE_NAME = namespaceFor(MAIN_COMPOSITION_ID, { kind: "main" })`, so
the main namespace has one derivation instead of a second literal.

### 3. The brand, threaded

`Namespace` replaces `string` on the accessors and every path derived from one:

- `plugins/infra/plugins/paths/core/internal/paths.ts` — `currentWorktreeName(): Namespace`,
  `MAIN_WORKTREE_NAME: Namespace`, `worktreeDataDir(ns: Namespace)`, and every
  member of `worktreeArtifacts` (`webDist`, `buildProfile`, `buildLogs`,
  `buildLogText`, `buildStatus`, `checkLog`, `releaseLogs`). `releaseWebDist`
  keeps a plain `worktree: string` — its docblock already says it is keyed by
  the checkout that built it, *not* a namespace, and the brand is what makes
  that distinction enforced rather than commented.
- `plugins/infra/plugins/worktree/server/internal/spec.ts` — `writeWorktreeSpec({ name: Namespace })`,
  `removeWorktreeSpec(ns: Namespace)`. This is the single writer the gateway
  discovers namespaces from, so branding it is what makes "every writer derives
  from the owner" a type error.

`checkoutWorktreeName(root): string` deliberately does **not** return a
`Namespace`. Post-Phase-3 the two genuinely diverge — a checkout name is one
input to a namespace, not a namespace — and today's four hand-rolled
`basename(root)` copies are exactly the confusion the brand exists to catch.
Those four sites collapse onto `checkoutWorktreeName` / `checkoutRef`.

`paths/server` gains:

```ts
export function checkoutRef(root: string): CheckoutRef;  // main iff root === getMainRepoRoot()
```

### 4. One URL builder, one host reader

`namespaceUrl` / `namespaceHost` replace the ~25 hand-built strings across
`cli/bin/commands/{build,deploy,start,release,serve-app}.ts`,
`cli/bin/commands/internal/compose-serve.ts`,
`infra/launcher/{bin/launch.ts,server/internal/boot.ts}`,
`auth/central/internal/handlers/oauth-callback.ts`,
`release/server/internal/preview-manager.ts`, the four debug MCP tools, and the
web sites in `build/plugins/serve-composition`, `studio/plugins/compositions`,
`deploy/plugins/local-serve`, `conversation-view/plugins/open-app`, and
`auth/web/components/accounts-pane.tsx`.

`namespaceFromHost` replaces the four identity parsers:
`agent-manager/plugins/worktree-switcher/web/components/worktree-dropdown.tsx:12`,
`tasks/plugins/task-draft-form/web/components/task-draft-form.tsx:73`,
`debug/plugins/logs/web/components/log-viewer.tsx:23`, and
`auth/web/connect.ts:100`. (`browser/plugins/omnibox/web/normalize.ts` stays —
it tests whether a typed string looks local, which is navigation heuristics, not
identity extraction.)

Both are backed by a `grepCode` check modeled byte-for-byte on
`checks/plugins/no-hand-built-link-to/check/index.ts`:

- **`no-hand-built-namespace-url`** — flags a `.localhost` string literal
  anywhere outside `infra/plugins/namespace/`, `gateway/`, `research/`, and
  test/e2e fixtures. Hint points at `namespaceUrl` / `namespaceFromHost`.

### 5. One grammar, pinned across three languages

- **`namespace:grammar-in-sync`** — a check that reads the `nameRegex` literal
  out of `gateway/registry.go` and the inline copy out of
  `framework/server-core/bin/select-registry.ts`, and asserts both equal
  `NAMESPACE_RE`'s source. This replaces the current `KEEP IN SYNC` comment
  (rung 5) with a check (rung 3). `select-registry.ts` genuinely cannot import
  the constant — boot cannot pull in `config_v2` — so a check is the strongest
  available rung there.

### 6. Symmetric collision guard

`composition-namespace.ts`'s `namespaceCollision` / `probeNamespace` become the
one function both sides call, taking a `Namespace` and returning a refusal
string or `null`. It gains the missing arm: a checkout may not claim a name that
is a known composition id. The composition-side arms it already has stay as-is.

Call sites:

- `cli/bin/commands/internal/compose-serve.ts:57` — already calls it.
- `plugins/build/plugins/serve-composition/server/internal/reset.ts` — already
  calls it.
- **new:** `plugins/infra/plugins/worktree/server/internal/worktree.ts`, where
  `worktreePathFor(id)` creates a checkout. Refuses loudly rather than creating a
  checkout whose namespace is already a composition's. Agent worktrees are
  always `att-<ts>-<slug>` (`conversations/server/internal/lifecycle.ts:59`), so
  this can only fire on a hand-named worktree.

`CompositionMarker` gains `checkout: string | null` (`null` = main), written by
compose-serve. That is the recorded pair the "no inverse" decision relies on.

### 7. The gateway

Two edits, both narrow:

- `gateway/proxy.go:473` — delete the `strings.Contains(name, ".")` rejection.
  The loopback short-circuit above it (`localhost` / `127.0.0.1` / `::1`) must
  stay ahead of the suffix check, since those hosts contain dots too.
- `gateway/registry.go:21` — `nameRegex` becomes the per-label composition
  `^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62})*$`. Written per-label
  rather than by adding `.` to the charset because that shape structurally
  forbids `..`, an empty label, and a leading or trailing dot — the only ways a
  dotted name could stop being a single safe path segment.

Nothing else in the gateway needs to change, and this was checked rather than
assumed:

- `name` is only ever used as one path segment (`filepath.Join(RegistryDir, name, "spec.json")`)
  or a filename stem (`name+".sock"`, `name+".log"`). No `strings.Split` on the
  name exists anywhere in the package, and there is no `filepath.Glob` /
  `path.Match` call, so a dot cannot become a separator or a metacharacter.
- The two exact-match special cases (`w.Name == "central"` in `ShouldSweep`,
  `w.Name != "singularity"` in the darwinbg demotion, `worktree.go:885,952`) stay
  correct: the main namespace is still exactly `singularity`.
- No cookie-domain, CORS, TLS/SNI, Host-rewriting or WS-origin logic exists to
  care about label count. The central-routes matcher is path-only.
- The gateway is left deliberately **dumb about the decomposition**. It treats the
  namespace as an opaque directory key, which is why the elision rule lives in TS
  only and there is no second implementation of it to drift.

Gateway note, not a blocker: the socket path budget is 104 bytes
(`worktree.go:29`), leaving ~60 chars for the name. `sonata.att-1787064474-2qcq`
is 26. A long composition plus a long checkout could exceed it, and the gateway
already refuses loudly with "rename worktree" — but a `<composition>.<checkout>`
namespace is not renameable by the user, so Phase 4 should surface the limit at
mint time. Out of scope here; worth an `add_task`.

---

## Files

**New**

- `plugins/infra/plugins/namespace/{package.json,CLAUDE.md,core/{index.ts,namespace.ts,namespace.test.ts}}`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/no-hand-built-namespace-url/check/index.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/namespace-grammar-in-sync/check/index.ts`
- both registered in `tooling/plugins/checks/core/index.ts`

**Changed — the owner and the identity**

- `gateway/proxy.go`, `gateway/registry.go` (+ `proxy_test.go`, `registry_test.go`)
- `plugins/plugin-meta/plugins/composition/core/namespace.ts` (constant moves out)
- `plugins/infra/plugins/paths/core/internal/paths.ts`, `plugins/infra/plugins/paths/server/`
- `plugins/infra/plugins/worktree/server/internal/{spec.ts,composition-namespace.ts,worktree.ts}`
- `plugins/framework/plugins/server-core/bin/select-registry.ts` (comment now names the check)

**Changed — the sweep** (mechanical, one pattern repeated)

- ~25 URL sites → `namespaceUrl` / `namespaceHost`. Representative:
  `cli/bin/commands/deploy.ts:208`, `cli/bin/commands/build.ts:428`,
  `infra/launcher/server/internal/boot.ts:649`,
  `build/plugins/serve-composition/web/internal/use-serve-status.ts:29`.
- 4 host parsers → `namespaceFromHost`. Listed in §4 above.
- 4 `basename(root)` copies → `checkoutWorktreeName` / `checkoutRef`:
  `cli/bin/commands/build.ts:790`, `e2e-harness/e2e/target.ts:38`,
  `test/bun-preload.ts:26`.

---

## Verification

**Unit**

```bash
./equin test plugins/infra/plugins/namespace
```

Covers: the four elision cases; that every `namespaceFor` output matches
`NAMESPACE_RE`; that `asNamespace` refuses `..`, `a..b`, `.a`, `a.`, `A`,
`a.b.c`, and over-length labels; that `namespaceFromHost` round-trips
`namespaceHost` and returns `null` for bare `localhost`, `127.0.0.1`, `::1` and
any non-`.localhost` host.

**Gateway**

```bash
cd gateway && go test ./...
```

New cases in `proxy_test.go` (there is no direct `parseWorktree` test today —
add one): `sonata.att-x.localhost:9000` → `sonata.att-x`; the three loopback
hosts still → `""`. New cases in `registry_test.go`: `Resolve` loads a spec from
`worktrees/sonata.att-x/`, and rejects `..`, `a..b`, `.a`, `a/b`.

**End to end — the actual capability**

With this worktree built and serving, hand-write a second spec dir pointing at
the same backend, and confirm the gateway serves it:

```bash
WT=att-1787064474-2qcq
mkdir -p ~/.singularity/worktrees/sonata.$WT
cp ~/.singularity/worktrees/$WT/spec.json ~/.singularity/worktrees/sonata.$WT/
curl -s -o /dev/null -w '%{http_code}\n' http://sonata.$WT.localhost:9000/api/health   # expect 200
rm -rf ~/.singularity/worktrees/sonata.$WT
```

Before the change this returns 404 with the gateway's
`Singularity gateway. Use <name>.localhost.` body. After it, 200 — which proves
the gateway half with nothing in Phase 4 built yet. Also open
`http://sonata.$WT.localhost:9000` in Chrome to confirm the SPA loads and its
own `namespaceFromHost` reads `sonata.<wt>` rather than `sonata`.

**No regression**

```bash
./equin check      # in particular: plugin-boundaries, plugins-doc-in-sync,
                         # plugins-registry-in-sync, composition-closure,
                         # no-hand-built-namespace-url, namespace-grammar-in-sync
./equin build      # run in background; verify via build-status.json
```

The build must behave identically — no namespace gains a dot in this phase, so
`http://att-1787064474-2qcq.localhost:9000` and
`http://singularity.localhost:9000` are unchanged. Spot-check the two surfaces
whose parser changed: the worktree switcher still shows the current namespace,
and Settings → Account still links correctly.

## Follow-ups this phase deliberately does not take

- Surfacing the 104-byte socket-path limit at mint time (Phase 4 territory —
  nothing mints a long name yet).
- Phase 4's first caller: `build --composition sonata` from a non-main checkout.
- `select-registry.ts`'s inline regex remains a copy, now check-pinned rather
  than comment-pinned. Removing the copy needs the boot path to stop being unable
  to import `config_v2`, which is its own task.
