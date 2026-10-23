# Singularity

Singularity is a self-evolving app for the agentic era. The goal is to have an app which can replace all others, customized for each individual user, at the boundary of an application and an operating system. The vision has a few steps:

- At first, the app itself is an Agent manager app whose goal is to fix todos faster than they are created. The app will be used to improve itself.

  The app is a nested todo list of tasks agents need to execute. Each agent executes in its own isolated `worktree` (including this current session) and deploys to `http://<worktree>.localhost:9000`. The UI allows seamless switching between namespaces to inspect agent work.

- The app evolves into a Notion-like WeChat: a single unified surface where agents compose user-tailored apps on the fly from plugin building blocks. Notion gives users composable blocks (databases, pages, views) to fit their workflow; Singularity does the same at the *app* level, with agents doing the composing. The agent manager becomes one such composition among many, sharing the same plugins and primitives.

- A plugin marketplace where users contribute and share building blocks. Each user gets a unique composition assembled by agents from marketplace plugins — not a one-size-fits-all tool, but a personal OS shaped to their workflow.

## Agent Workflow

Agents work in isolated, auto-created git worktrees:

1. Solve the request.
2. Deploy with `./singularity build` (frontend + server + gateway registration).

   **Use `run_in_background: true` and end your turn** — build/push/check take ~10 min (median), over the 600 s foreground cap. The background task re-invokes you on exit; nothing to wait for or watch. Every backgrounded `./singularity` call is rewritten to the 2 h timeout ceiling (the 30 min default would kill it). Guards enforce all three.

   **A SUBAGENT must not end its turn there** — it is never re-invoked (its completion notification lands in the parent's queue). Background the op, then call `./singularity await <op>` in the FOREGROUND: it blocks until the verdict and prints it (exit 0 ok, 1 failed, 70 still running — call again). A stop hook refuses a subagent turn that walks away from its running op.

3. The app is served at `http://<worktree>.localhost:9000` (always write `http://` so it's clickable).

4. Once reviewed, `./singularity push -m "…"` merges to main (pulls main, merges, pushes).

RULES:

- NEVER `./singularity push` unless instructed — the user reviews first. (A Dependencies-category upgrade task — or legacy Toolchain-category — counts as instruction; its text says when it may push. See `plugins/infra/plugins/deps/plugins/updates`.)
- NEVER `git commit` yourself (branch conflicts). Always `./singularity push -m "commit message"`.
- **Always rebase, never merge** (`git rebase origin/main`). Never `git merge origin/main`; never `git reset` a branch onto `main` (deletes the commits in between). Exception: `./singularity upstream merge` (see Upstream).
- NEVER run `drizzle-kit generate` or the migration runner manually — `./singularity build` does it.
- **Review diffs against the merge-base**: `git diff $(git merge-base HEAD main)`, not `git diff main` (which includes later main commits).

### MCP Tools

Agents have access to MCP tools provided by the Singularity server. Key tools:

- `query_db` — Read-only SQL query against the worktree's PostgreSQL database. For **debugging and inspection only** — mutations are rejected at the DB level. Defaults to the agent's own worktree DB; pass `database` to query another worktree or `"singularity"` for main.
- `add_task` — **When the user asks to "add a task", always use this MCP tool.** Never use the TaskCreate tool (that is for the agent's own internal task tracking during implementation, not for adding tasks to the Singularity task system).
- `read_page` / `edit_page` / `write_agent_note` — pages, shaped like `Read` / `Edit` / `Write`. **These write to the SHARED instance (normally main), not your worktree** — the opposite default from `query_db`, because pages are prod documents you edit collaboratively with the user, not something to test on. **You may only write INSIDE an agent-authored block: an `<agent-inline>` card, or an `<agent-page>`.** `edit_page` takes any block id, but every block its diff creates, rewrites, moves or deletes must sit in one (a tagless `<agent-inline>` in your replacement text mints a card; a tagless `<agent-page title="…">…</agent-page>` mints a sub-page whose whole content is yours, written afterwards by its own id); a page's own prose is read-only — you annotate it, you do not edit it. Pages can carry instructions from their author: `read_page` hands you the ones covering what you read, a write is refused until you have received them, and global ones arrive when the conversation starts.

## Architecture

Every feature is a **plugin**. The core app is thin plumbing that connects plugins together via a slot-based extension system.

Always READ the plugin architecture doc to understand design, caveats, and rules:

- Frontend: [`plugins/framework/plugins/web-sdk/CLAUDE.md`](plugins/framework/plugins/web-sdk/CLAUDE.md)
- Backend: [`plugins/framework/plugins/server-core/CLAUDE.md`](plugins/framework/plugins/server-core/CLAUDE.md)

Think carefully about the plugin's boundaries, APIs, etc. when designing plugins, as it is the load-bearing infra of the entire project.

**Deployment model — one instance per user.** Singularity runs as exactly one instance per user: the marketplace shares *plugins*, not runtime, and multi-tenancy is a non-goal. This is a recorded architectural decision — read it before touching auth, the gateway, DB forks, secrets, or the live-state subscription path: [`research/2026-07-02-global-adr-single-instance-per-user.md`](research/2026-07-02-global-adr-single-instance-per-user.md).

### Collection-consumer separation

When a plugin collects sub-plugin contributions (e.g. facets, checks, collected dirs), consumers must use only the **generic collection API** — never import or name individual contributors. The collection plugin owns the registry and generic interface; each contributor implements the internal details. Adding or removing a contributor updates all consumers automatically with zero code changes. If a consumer needs to reference a specific contributor, the abstraction is leaking — redesign the generic API instead.

This pattern applies to *genuinely open* sets — ones where future plugins must add entries without editing your code. For a **closed list** both runtimes need (types, constants, a dropdown's options, a validation allowlist), prefer plain data in `core/` rather than introducing a slot and the web↔server codegen bridge it implies for a set you can enumerate today.

### Plugin boundary rules

Enforced by `./singularity check boundary-rules` (which folder may import which — the `folders` table in `plugins/framework/plugins/tooling/plugins/boundaries/core/boundary-config.ts`) and `./singularity check plugin-boundaries` (import grammar, barrels, cycles; rules R1–R13). Details: [`boundaries/CLAUDE.md`](plugins/framework/plugins/tooling/plugins/boundaries/CLAUDE.md), [`plugin-boundaries/CLAUDE.md`](plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/CLAUDE.md).

- **Known folders only** (vocabulary in `plugins/framework/plugins/plugin-id/core`): barrel folders `web`, `server`, `central`, `core`, `shared`, `e2e`, `provision`, `data-dirs`, `cli`, `deps`; leaf folders `check`, `lint`, `facet`, `bin`, `scripts`, `exhibits`, `vite`, `prewarm`, `python`, `exempt`; plus `plugins/` for children. No loose root `.ts`, no unclaimed file under `plugins/`. A new folder kind = a vocabulary entry + its table row (tsc enforces the row).
- **One import table, inside and across plugins.** Each folder's row lists the barrel folders it may import (`core` → `core`; `web` → `web`, `core`, `shared`; `e2e` → `e2e`, `core`, `data-dirs`). Relative imports in your own plugin obey it too (`core/` → `../server/x` fails). Leaf folders are never import targets. `core/` is the public channel, `shared/` the plugin-private one.
- **One barrel per runtime.** `plugins/<name>/<runtime>/index.ts` is the only cross-plugin entry point — no `api.ts`, no deep paths.
- **Import grammar.** A specifier ends at a barrel folder (`@plugins/<name>/<runtime>`, `@plugins/<name>/plugins/…/<runtime>`) or at `<runtime>/testing`. Forbidden: cross-plugin `shared/` (R10; your own is imported relatively), paths inside a barrel (`/web/components/`, `/server/internal/`), workspace names (`@singularity/plugin-shell`), `../` escapes into another plugin.
- **Test code** = `*.test.ts(x)`, `__tests__/`, or `<runtime>/testing/` (never under `e2e/`). It follows its folder's row; only test code and `check/` may import it (`e2e/` ships, so it may not). A public barrel publishes no test support: no `*ForTest(s)` names, nothing from a test-support module (R12), no name only tests import (R13). Own tests import by relative path; reusable helpers go in `<runtime>/testing/`.
- **No cross-plugin re-exports** — import the source barrel directly (`@plugins/tasks/plugins/task-draft-form/web`, not a proxy via `@plugins/tasks/web`). Enforced transitively and by name (through an internal file, or import-then-export); no umbrella→descendant exception.
- **Barrel purity.** `index.ts` holds only imports, re-exports of own files, type aliases, and one `export default { … } satisfies PluginDefinition`. No `const`/`let`, logic, or side effects.
- **Registry exclusivity.** Default-export plugin imports live only in the generated registries (`{web,server,central}.generated.ts` under `plugins/framework/plugins/{web-sdk,server-core,central-core}/core/`) and the `bin`/`App.tsx` roots (the `exclude` list in `boundary-config.ts`). Never register by hand: create `<runtime>/index.ts` and `./singularity build` (`plugins-registry-in-sync` catches drift).
- **Exemptions are declared by the exempted plugin**, in its `plugins/<p>/exempt/index.ts` (`rule`, plugin-relative `paths`, `kind: "sanctioned" | "debt"` + `reason`, `task` for debt). Never hand-roll an allowlist (`ALLOWED_FILES`, `ignores`, `.startsWith("plugins/…")`) in a rule — `exempt/no-path-allowlist` rejects it; exempt a whole kind of file with `outOfScope`. List: `./singularity exempt list [--rule <id>] [--plugin <path>] [--debt]`. Details: [`exempt/CLAUDE.md`](plugins/framework/plugins/tooling/plugins/exempt/CLAUDE.md).
- **No cycles.** The cross-plugin import graph is a DAG; type-only imports count.
- **Search before writing a helper or fixture.** The plugin's own `CLAUDE.md` has an autogen reference (exports, uses, importers, contributions, test helpers); `docs/plugins-details.md` has it for every plugin, incl. reverse indexes (who imports me, contributes to my slots, calls my endpoints). A list over 20 values is summarized as per-group counts; the plugin's `REFERENCE.md` lists it in full. Kept in sync by `plugins-doc-in-sync`.

### Folder Structure

```
├── plugins/          # All features, each as a self-contained plugin
│   ├── framework/    # Framework primitives (web-sdk: slots, contributions)
│   └── {name}/
│       ├── web/      # Frontend code
│       ├── server/   # Backend code
│       ├── central/  # Central-runtime code (shared across worktrees)
│       ├── core/     # Public API — types/utils importable cross-plugin and from server/web
│       ├── shared/   # Private DRY — shared between web/server within this plugin only, never imported cross-plugin
│       ├── cli/, e2e/, provision/, data-dirs/, deps/   # other barrel folders (CLI verbs, Playwright scripts, install steps, data-dir declarations, on-demand dependency declarations)
│       ├── lint/     # ESLint rules contributed by this plugin (optional)
│       ├── check/    # Custom Check[] enforced by ./singularity check (optional)
│       ├── exhibits/ # Real components shown standalone — the `plugin-meta/exhibits` catalog (optional)
│       ├── bin/, scripts/, facet/, vite/, prewarm/   # other leaf folders — discovered or run by path, never imported
│       └── plugins/  # child plugins
├── web/              # Frontend bootstrap (SPA shell, plugin registry)
├── gateway/          # Namespace proxy (Go). See [`gateway/CLAUDE.md`](gateway/CLAUDE.md)
├── cli/              # Agent CLI (TypeScript, Commander.js)
├── sidequests/       # Independent side projects (see Sidequests section below)
└── research/         # Research docs and plans
```

### Workspaces

The project uses bun workspaces (defined in root `package.json`). Run `bun install` from the repo root. Shared dependencies (react, icons, types) live in the root `package.json`. Plugin-specific dependencies live in each plugin's `package.json`.

### Key Plugins

- `shell` — App layout (sidebar, toolbar, main area, status bar). Defines the standard slots other plugins contribute to.

## CLI

### Deploy

Always deploy after changes: `./singularity build`, from the worktree directory (not the main repo root). It regenerates DB migrations from `schema.ts` (applied on server restart), builds frontend and server, restarts the server and registers the worktree with the gateway (`http://<worktree>.localhost:9000`).

> **NEVER run `./singularity start` / `stop`** (install / stop the gateway as the machine's launchd service) unless the user explicitly asks.

### Check

```bash
./singularity check                       # all checks
./singularity check --list                # list checks
./singularity check migrations-in-sync    # one check (id as positional arg)
```

Checks run first in `push`, and in `build` after migration/doc generation (unless `--skip-checks`). Built-ins live in, and are registered in, `plugins/framework/plugins/tooling/plugins/checks/core/index.ts`. Plugins contribute their own (discovered at runtime, no registry edits):

- `plugins/<name>/lint/index.ts` — default-export `{ name: "<plugin-id>", rules: { ... } }` of ESLint v9 rules. Each rule is enabled as `error` **repo-wide** (`**/*.{ts,tsx}`), not just in the contributing subtree; the `eslint` check runs them.
- `plugins/<name>/check/index.ts` — default-export `Check | Check[]` (same interface as built-ins), id `<plugin-name>:<check-id>`.

Notable built-ins: `migrations-in-sync` (schema changes without a committed migration — fix with `./singularity build`), `type-check` (one repo TS program → tsc diagnostics + type-aware ESLint, plugin lint rules included).

### Push

`./singularity push -m "message"`:

1. Run checks
2. Fail if dirty
3. Push the branch
4. Pull main (`--ff-only`)
5. Merge the branch into main (from the main worktree)
6. Push main
7. Main auto-builds on the `refs/heads/main` advance — never build/redeploy main yourself, and don't report it as a caveat.

> **CRITICAL — NEVER push or commit on your own initiative.** No raw `git commit` / `git push`. "push", "publish", "ship" all mean `./singularity push`.

Steps 3, 4, 6 (the only network git) run only when this checkout can write to its remote (probed once, cached in `.git/config`; `plugins/infra/plugins/git/plugins/remotes`). Without write access the work lands on local `main`, which main's auto-build watches.

### Upstream

For a checkout cloned from someone else's repo, that repo is **upstream** (read-only). A daily main-only job records a report when it has new commits (no task; the report's Investigate button mints one). An update is an ordinary task: `./singularity upstream merge` in a worktree, resolve, build, review; the user lands it with `push`. See `plugins/upstream`. This checkout owns the canonical repo, so it has no upstream.

### `--from-main` (dangerous)

`./singularity push --from-main -m "…"` commits and pushes straight from main. **Never pass it without explicit user approval in the current conversation, for this push** — not from memory, a prior session, or a CLAUDE.md rule. On main with no worktree branch for the changes: stop and ask.

## Ports

- The gateway listens on **port 9000** for all browser traffic, routed by subdomain (`<name>.localhost:9000`). The main namespace (agent manager app, served from `main`) is always at `singularity.localhost:9000`.
- Backends do **not** listen on TCP. The gateway hands each backend a per-worktree Unix domain socket at `~/.singularity/sockets/<name>.sock` and dials it directly. There is no backend port range to allocate.

## Driving the app (screenshots & E2E)

`./singularity build` first: every script resolves its target from the deploy registry THIS checkout's build wrote, and refuses when there is none. Never hand-write `http://<worktree>.localhost:9000` — in an agent session the name comes out as `singularity` and the run drives main. Chromium is an on-demand dependency (`infra/deps`), installed on the first browser run (~280 MB).

**Main is read-only for agent sessions**: on main, a write from the agent browser or an e2e run is refused with a 403 (telemetry excepted) — to exercise a write, drive your own build.

**Explore interactively with the `browser_*` MCP tools** ([`infra/mcp/browser`](plugins/infra/plugins/mcp/plugins/browser/CLAUDE.md)) — a headless tab that stays open across calls: routes (`/agents/…`) open your own build (so they need one), an absolute URL (any website, or main) works before you have built; script what must be repeatable with the headless scripts below. Not Claude-in-Chrome: that is one shared Chrome on the user's screen with their real accounts — only for what needs it (their sign-ins, a state they have open, a demo they watch).

**A script failed mid-flow? Continue from where it stopped**: call `browser_attach`, rerun the script with the `--attach <ticket>` it returns — it drives a tab of your `browser_*` session instead of its own browser and leaves it there, pass or fail — then inspect that tab with `browser_*`.

**Snapshot / verify behavior** (click, confirm state) with [`screenshot.ts`](plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts) — prints the resolved deploy and the matched button's state, writes `-before.png` / `-after.png`:

```bash
./singularity run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --out /tmp/shot
./singularity run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
  --path /agents/c/<id> --click "Artifacts" --out /tmp/artifacts
```

**One component on its own** (an exhibit — `plugins/plugin-meta/plugins/exhibits`): `./singularity run plugins/plugin-meta/plugins/exhibits/e2e/exhibit-shot.ts --id <group/name> [--width <px>] [--theme <app-id>|chrome]`. With `browser_*`: `/debug/exhibit-stage/<group>/<name>;width=<px>?embed=1` is the component alone (viewport = width); `/debug/exhibit/<group>/<name>` shows every width.

Flags: `--path <route>`, `--viewport 1280x900`, `--wait <ms>`, `--color-scheme dark|light`, `--composition <id>` (a composition this checkout built), `--url http://<namespace>.localhost:9000` (escape hatch for a deploy you didn't build — skips the is-this-my-build check).

**Compare a prototype against the real app** it mocks (`<meta name="mocks">`: a route, the whole app, or `exhibit:<id>`) with [`compare-diff.ts`](plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts): captures both frames at one size and 100% zoom, writes a red-on-grey diff and side-by-side sheet, logs the differing-pixel ratio, a per-cell heatmap and a colour report (dominant colours, region means, luminance profiles):

```bash
./singularity run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts \
  --name <proto-id> [--width 1280] [--options <name>=<value>,…] [--out /tmp/compare] [--fail-above 5]
```

`--width` must be a canvas size preset (omit for the mock's declared viewport); variants are captured at their defaults unless `--options` picks one.

**Repeatable flows**: a standalone script at `plugins/<path>/e2e/<name>.ts` in the plugin it verifies — never `*.test.ts` (the test runner would pick it up). Manual only. Running an `e2e/` script is an op (host CPU grant, "E2E in progress" banner); other `./singularity run` scripts are not. `--headed` to watch.

- Shared helpers (argv, target, `withBrowser`, `report()`): `@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e` — extend it, don't hand-roll. Domain flows go in the owning plugin's `e2e/index.ts`.
- `e2e` imports only other plugins' `core` and `e2e` barrels — it drives the deployed app, not the code under test.

## Debugging

Browser/server logs persist to `~/.singularity/worktrees/<wt>/logs/<channel>.jsonl` (one JSON `{t,stream,line}` per line). Emit from the browser via `clientLog(channel, line)`. Read them by `tail`/`cat` on the file. See [`plugins/debug/plugins/logs/CLAUDE.md`](plugins/debug/plugins/logs/CLAUDE.md).

## Sidequests

Independent projects that live in `sidequests/`, not directly related to Singularity. Each has its own `CLAUDE.md`.

- [`sidequests/ui-mastery/`](sidequests/ui-mastery/CLAUDE.md) — Research and tooling to make agents produce professional UI. **Read before any UI polish work.** Feature agents build functionality; polish agents apply UI Mastery knowledge separately.
- [`sidequests/monitors/`](sidequests/monitors/CLAUDE.md) — Host-level launchd monitors that watch the machine from outside the app, for failures the app's own observability cannot survive (FD leaks before a crash; worktree checkouts deleted under a live conversation). None are auto-installed.

## Instructions

### Agent Workflow Rules

- Most features need a design phase first: use the project `plan` SKILL (it puts the plan doc in the right place). Do NOT use `EnterPlanMode`.
- New features are plugins in `plugins/` — see [`plugins/framework/plugins/web-sdk/CLAUDE.md`](plugins/framework/plugins/web-sdk/CLAUDE.md).
- Read the matching SKILL first: `create-app` (new top-level app), `debug` (before debugging — logs, profiling, crashes, DB, queues), `theme` (tokens, tweakcn, per-app config, typography/radius/z-index), `css` (layout mental model — containers share space, leaves truncate — and the layout-primitive index).
- Before writing or editing a prototype, read [`prototypes/CLAUDE.md`](prototypes/CLAUDE.md). Prototypes live outside the repo in `~/.singularity/apps/prototypes/<name>/`, shared by every worktree and live at `http://singularity.localhost:9000` with no build or commit. Design from the blank `_template/`. Do not open other prototypes for inspiration.
- Always edit files in your worktree, not the main branch.
- **No unbounded `find`** — it has crashed macOS (65k DIR FDs via the bfs shim). Use `rg --files -g '<glob>'` or `fd '<regex>'`; `find` only with `-maxdepth` / `-prune`.
- **Run scripts with `./singularity run <file>.ts`, never bare `bun <file>.ts`** — bare `bun` resolves dependencies by walking UP, so a worktree without `node_modules` runs against main's (or a mid-install npm state). `./singularity run` installs this worktree's lock first. The `bun-script` guard blocks the bare form (machine-launched scripts importing no npm package stay bare).
- **STOP on unexpected failures; never improvise around them.** Surface it and ask — don't route around (e.g. curl after a failed MCP call). A loud failure is debuggable; a workaround on a broken assumption is not.
- **Subagents: always pass `model: "sonnet"`** to `Agent`. Opus only for load-bearing, complex implementation; research, lookup, synthesis and reporting are Sonnet work.
- **On breakage, rebase to HEAD first** (`git fetch origin main && git rebase origin/main`) — it may already be fixed.
- **Don't memorize gotchas — report them so they get fixed structurally.** On a footgun (silent-`undefined` API, "you must also update X" coupling, boot-crash-if-misplaced, build trap), do NOT write a memory file; surface it to the user or `add_task` it, to be removed at the highest rung of the fix ladder (Coding Style). Durable how-it-works knowledge goes in `CLAUDE.md` / `docs/`, not personal memory.
- **When the user explicitly says "Exit"**: call exactly one MCP tool — `exit_clean` (all smooth; the conversation closes) or `flag_raise({ reason })` (caveats, partial outcomes, follow-ups, skipped work, push didn't land; short bullets) — then write the final wrap-up (summary, issues, caveats, follow-ups).

### Quotable choices: `<go>`

Answer normally, and wrap in `<go>…</go>` each part of your answer the user could pick as their reply — an option, a next step, a follow-up. It renders tinted as one unit, `[text | ▶]`: ▶ sends it back, clicking the text puts it in the prompt to edit (a checklist block has ✎ / ▶ on its right edge).

```
I've done the change. Should I <go>implement it</go>? Or <go>file a task</go>?

Possible follow-ups:

<go>
- [ ] Xxx
- [ ] Yyy
</go>
```

- One line is inline, wherever it is written; a multi-line `<go>` is a block.
- In a block, `- [ ]` lines become a checklist and only the **picked lines** are sent; any other text in the block is for the reader. `- [x]` pre-picks the ones you recommend.
- **Items with columns → a table inside `<go>`**, each row's first cell starting `[ ]` / `[x]` (`| [x] **Themes** | problem | proposal |`). The table is the choice — never follow a table with a checklist repeating its rows. A picked row comes back as `- [x] <first cell>`.
- **One choice per item — never cluster.** `- [ ] File the 3 follow-ups` is wrong: list each follow-up on its own `- [ ]` line.
- **A `<go>` in a USER message is the part of your answer the user picked** (possibly reworded) — do it, don't answer it as a question. A checklist comes back as just the picked `- [x]` lines; anything you listed that is missing was declined. Text around it is the user's own addition and wins over it.
- **…unless it's a quote.** Inside a question or remark ("why <go>X</go>?"), a `<go>` just points at your text — answer the remark, don't do X. Infer from context.

Details: [`plugins/active-data/plugins/go/CLAUDE.md`](plugins/active-data/plugins/go/CLAUDE.md).

### Testing

**`./singularity test` is the ONLY way to run tests** — paths only, no flags, no setup (installs dependencies when stale). Never bare `bun test` / `vitest`. Optional and manual; a run is an op (host CPU grant, "Test in progress" banner).

```bash
./singularity test plugins/primitives/plugins/optimistic-mutation   # one plugin
./singularity test                                                  # everything
```

- Two runners, split by location: `*.test.ts(x)` beside its source = pure logic; `web/__tests__/` = jsdom/React (auto-discovered by root `vitest.config.ts`).
- Your own plugin's tests import the file under test by relative path, never via the public barrel.
- Reusable helpers go in `<runtime>/testing/index.ts` (imported as `@plugins/<name>/<runtime>/testing`) — never the public barrel, `__tests__/`, `check/`, or loose. Runtime by user: `web/testing/`, `server/testing/`, or `core/testing/` for both. A testing barrel may re-export a real function another plugin's test checks against. Only test code and `check/` may import it. Search `[test helpers]` / *Test helpers* in `docs/plugins-details.md` before writing a fixture.
- jsdom tests run on a pinned clock (fixed instant, `Date` only, still ticking; pin your own "today" if needed), locale `en-US` and timezone `UTC`.
- The split, pinning and `test-layout:runner-split` check live in [`plugins/framework/plugins/tooling/plugins/test-layout`](plugins/framework/plugins/tooling/plugins/test-layout).

### Coding Style

This is the single most important coding principle:

- **Prefer the clean design over the hacky one, even when it's more work.** Ask: "what primitive or abstraction would make this *and* future similar cases trivial?" — then build that, rather than patching the symptom.

---

- **Search and reuse existing concepts and APIs, rather than introducing new ones.** Before adding a type, hook, helper, slot, config key, table or term, search for one that already expresses it.
- **Group related plugins under an umbrella.** For 2+ related plugins, prefer an umbrella parent (`plugins/<umbrella>/plugins/<child>/`) over flat top-level entries. This keeps `plugins/` readable as semantic categories rather than an unbounded flat list. The umbrella doesn't need to re-export children's APIs — each sub-plugin owns its barrel.
- **Before adding a plugin to `infra/` or `primitives/`, ask whether it belongs under a more specific umbrella** — it usually does. Do not add new top-level plugins to either folder; nest under an existing sub-umbrella instead.
- **No polling — use push-based mechanisms.** Never use `setInterval`/`setTimeout` loops to check for changes. Use file watchers, DB `LISTEN/NOTIFY`, WebSocket messages, a live resource (`network/live`), or the `events`/`jobs` plugin. If the upstream source has no change signal, use a `defineJob` with a schedule (not an in-process timer) and document why.
- **Fail loudly — never silence errors.** Visible crashes are good: they surface the structural issue so it gets fixed. Never swallow exceptions, hide error states, or add fallbacks that mask broken assumptions. ESLint enforces `no-floating-promises` and `no-bare-catch`. Correct patterns: `await promise` (preferred), `.catch((err) => { if (err instanceof Expected) handle(err); else throw err; })` (specific handling), or `void promise` (intentional fire-and-forget). Never: bare `promise;`, `.catch(() => {})`, `.catch(console.error)`.
- **Failure must be a type, not an absorbable value.** A fallible function either throws or returns a discriminated result (`{ok:false,…}` / `{kind:"error",…}`) — never `null`/`[]`/`""`/`0` that a consumer can mistake for a legitimately-empty success (ESLint: `no-absorbed-failure`). See the throw-vs-result decision rule in the `api-design` SKILL and `research/2026-07-08-global-absorbable-failure-guardrail.md`.
- **Not-known-yet is a state to render, never a value to stand in for.** A surface without its data yet shows a loading state — never what "no data" would look like (empty list, zero count, off switch, "nothing configured"), which is a claim about the user's data that then reverses itself. Enforce it above the render site: the read returns a state, not a stand-in (`useLive` / `useLiveRow` / `useConfigResult`; a per-state model shape is a union, so downstream cannot accept the unknown arm), the primitive owns the pending affordance (`Button` auto-pends, `DataView`'s `loading`), `live-state/no-pending-data-collapse` bans the collapse, and `primitives/loading` renders it. Best of all, remove the window: cheap boot-hydrated inputs everything reads declare `preload: "boot-and-keep"`.
- **Live state is declared through `network/live`; a DB-backed collection is bounded by construction.**
  A new collection is `liveCollection` + `serveCollection` (a required default `limit` and
  `maxLimit`, or lookup-only by id), so every read/recompute is O(window ∪ changed), never
  O(collection). A new value is `liveValue` + `serveValue`; a `source: "db"` array or record value
  must state `unbounded: { reason }` (tsc). Read both with `useLive` / `useLiveRow`. The old
  spellings that still exist (`defineResource`, `useResource`, …) remain only as the
  substrate the unified API compiles to; the
  `live/no-legacy-resource-spelling` lint rejects them elsewhere — never copy one as precedent. A
  new way to read server data is an option `useLive` reads, never a new hook (its Design rule). See
  `plugins/network/plugins/live/CLAUDE.md`.
- **Collections of domain records are DataViews.** Rendering a homogeneous set of domain records (rows from DB / live-state / config) is a `data-view` surface (`views={["list"]}` minimum — search/filter/sort/groupBy/item-actions come free), never a hand-rolled `.map()` of `<Row>`. `Row`+map is only for transient chrome (menus, pickers, tab strips), annotated `// eslint-disable-next-line data-view/no-adhoc-row-list -- <reason>` (ESLint: `no-adhoc-row-list`). See `plugins/primitives/plugins/data-view/CLAUDE.md` and `research/2026-07-17-global-data-view-adoption-guardrail.md`.
- **Fix the structural issue, not the specific instance.** When something breaks, take a step back and ask why it was possible in the first place. A targeted fix in one call site leaves the rest exposed.

  **Structural fixes are ranked — take the highest rung that can express the constraint, even when it's more work or churns call sites:**

  1. **Inexpressible** — rethink the API, abstraction or mental model until the wrong thing has no spelling: drop the parameter, derive the value, take the data not the callback, delete the concept. Nothing left to enforce.
  2. **Type error** — `tsc` rejects it: required field, discriminated union, branded type.
  3. **Check/lint error** — cross-file invariants a type can't see ("these two must agree", "don't use X here").
  4. **Loud runtime failure** — an assert at the boundary, for what only runtime knows.
  5. **Documentation** — weakest; reaches only whoever reads it. Never when a rung above fits.

  The rungs rank enforcement strength, not the space of fixes — invent the fix that makes the class of mistake impossible, then use the ladder to take its strongest form.
------------------------------------

@docs/plugins-compact.md
