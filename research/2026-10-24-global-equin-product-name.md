# Step 4 — the product name people read is "equin"

`<old>` below stands for the product's former name (`LEGACY_PRODUCT_NAMES` in `plugins/framework/plugins/product-name/core`): the repo no longer spells it, and `product-name:legacy` would flag this doc if it did.

Track: *Rename <old> to equin* (page `block-dc049371-1f5f-413d-af7b-6e12b531d579`).
Steps 1–3 (plans `2026-10-24-global-equin-cli-name-sweep.md`, `…-equin-main-host.md`) moved the CLI and the main address.

## Context

The app and its docs still call the product "<old>" in places people read: install.sh
("<old> is running: …"), doctor output, the OAuth "complete the setup in <old> Settings"
page, the "needs <old> running on your computer" message, the gateway's 404 text, the cost
stats toggle ("<old> only"), the file explorer's "<old>" place, backup source names,
the Drive folder "<old> Backups", service descriptions in launchd/systemd, User-Agents, and
README / CLAUDE.md / docs / CITATION.cff titles. Agents read it too, in MCP tool descriptions and
page instructions ("Read a <old> page", "Add a task to the <old> task tree").

Goal: a person or agent only ever reads **equin**. Decisions taken with the user:

- **Always lowercase "equin"**, even at the start of a sentence and in titles (the website's
  convention). The existing "Equin" spellings are lowercased as well: the tab title
  (`apps-layout.tsx`), the CLI description (`cli/bin/cli.ts`), the desktop `productName`
  (`tauri/src-tauri/tauri.conf.json`, so the bundle becomes `equin.app` / `equin.dmg`) and Cargo
  description.
- **The Drive folder is renamed in place**: existing backups stay in it.

**Out of scope** (the track's separate decision item): the `singularity` namespace and DB,
`~/.singularity/`, `SINGULARITY_*` env vars, package names, plugin folder names
(`singularity-platform`), stable ids (`singularity-platform` backup source id, the `"singularity"`
place id, which saved orderings key on), `dev.singularity.*` service labels, the
`Singularity-Conversation:` / `<old>-*` commit trailers (wire format), and camelCase code
identifiers (`isSingularity`, `useSingularityPlace` — internal, renaming them is churn; the sweep
leaves them).

## Design

### 1. One owner of the name: `plugins/framework/plugins/product-name` (new leaf plugin)

Mirrors `framework/cli/plugins/cli-name` (which owns `CLI_NAME` / `CLI_NAMES`):

- `core/index.ts`: `PRODUCT_NAME = "equin"` and `LEGACY_PRODUCT_NAMES = ["<old>"]`.
- Code that composes the name into a string reads `PRODUCT_NAME` where it is a value, not prose:
  `document.title` in `apps-layout.tsx`, the CLI `program.description`, `needsMachineMessage`
  (`infra/endpoints/core/needs-machine.ts`), User-Agents (`page/bookmark` scrape,
  `events/url-extract` probe, `desktop/wallpaper/openverse` search), the Drive folder name.
  Prose (docs, comments, hints) just writes "equin" — a constant inside every sentence is noise.

### 2. Check `product-name:legacy` (rung 3), in `product-name/check/index.ts`

Same shape as `cli:legacy-cli-name` and `namespace:legacy-host`: every tracked text file
(`listCandidateSources({ grepArg: "<old>", fixed: true, pathspecs: ["."] })`, prose
included), flagging `\bSingularity\b(?!-[A-Z])` — case-sensitive capital-S word, so it catches the
product name in prose and strings but not lowercase identifiers (`singularity` namespace, paths),
camelCase identifiers (`isSingularity`) or the `Singularity-Conversation:` trailers. Exemptions via
`exempt/index.ts` with `rule: "product-name:legacy"` for files that must spell the old name on
purpose (the check itself, the Drive migration's old-folder name, a test pinning the old CN; see
below). Hint: write "equin"; code uses `PRODUCT_NAME`.

### 3. The sweep (~400 mentions)

Mechanical `<old>` → `equin` over the same regex, then a read-through of the diff for
grammar ("a equin…" → "an equin…", "<old>'s" → "equin's", sentence starts are lowercase by
decision). Scope, all tracked files:

- **User-visible strings**: `install.sh` (header, banner, mise comment, "equin is running: …"),
  `doctor.sh` output, `auth/central/.../oauth-start.ts` page, `gateway/proxy.go` 404 text,
  `infra/launcher/.../gateway-service.ts` service description, `stats/cost` config label and
  description + `scope-toggle.tsx` + `config/stats/cost/config.origin.jsonc`, the file explorer
  place label (`places.ts`; id `"singularity"` kept), backup source names / config label
  (`singularity-platform/*`, `sources/config`), `deploy/servers/.../ssh-key-error.ts`,
  `cli/db` + `cli/build` messages, `prototypes/files/shared/history/git.ts` committer name,
  `codesign` `LOCAL_IDENTITY_NAME` (affects only newly created certs; an existing machine keeps
  its cert — its SHA-1 is what permission grants pin, so nothing is re-granted — and still shows
  its old CN, which is read from the cert).
- **Agent-read strings**: MCP tool descriptions (`tasks/machine/.../mcp-tools.ts`,
  `page/annotations/agent-access/.../mcp-tools.ts`, `instructions-gate.ts`), `task-triage`
  profile, `todo/task-link` prompt, `hints/ask` instructions ("equin (this app — <old>)" →
  "equin, this app"), guard hints (`git-push.ts`, `package-json-hint.ts`).
- **Plugin descriptions** (they feed `docs/plugins-*.md` and the per-plugin CLAUDE.md autogen —
  regenerated by `./equin build`).
- **Docs and prose**: README.md and root CLAUDE.md titles + intro, `docs/setup.md`,
  `gateway/CLAUDE.md`, per-plugin CLAUDE.md hand-written parts, CITATION.cff `title`,
  comments, research/ and sidequests/ (steps 2–3 swept research too; the check covers every
  tracked file, so it has to).
- **Tests** whose expectations pin the strings above (`needs-machine` messages, `systemd-unit` /
  `launchd-plist` descriptions, `codesign.test.ts`, `page-meta.test.ts` fixture title,
  `git-push.test.ts` names) — updated with the source.

### 4. Two coupled spots that are not plain text swaps

- **Gateway 404 ↔ secrets matcher.** `infra/secrets/.../operations.ts` `isCentralOffline` matches
  the gateway's body `includes("<old> gateway")`. A running gateway binary keeps the old text
  until it is rebuilt, so the matcher switches to the part both texts share,
  `"gateway. Use <name>.localhost"`, with the comment saying why. (Not caught by
  `namespace:no-hand-built-url`: no quote directly before `.localhost`.)
- **Drive folder rename in place** (`backup/targets/google-drive/.../folder.ts`): search for a
  folder named `PRODUCT_NAME + " Backups"` (→ "equin Backups") or the legacy
  "<old> Backups"; if only the legacy one exists, `PATCH /drive/v3/files/<id>` with the new
  name, then use it; if neither, create the new one. The legacy name literal is covered by a
  `product-name:legacy` exemption (`kind: "sanctioned"`: a migration that can be removed once
  every install has run a backup).

## Critical files

- new: `plugins/framework/plugins/product-name/{core,check,exempt}/index.ts`, `CLAUDE.md`
- `install.sh`, `plugins/framework/plugins/cli/plugins/doctor/doctor.sh`, `gateway/proxy.go`
- `plugins/infra/plugins/secrets/server/internal/operations.ts`
- `plugins/backup/plugins/targets/plugins/google-drive/server/internal/folder.ts`
- `plugins/apps-core/plugins/layout/web/components/apps-layout.tsx`, `plugins/framework/plugins/cli/bin/cli.ts`, `tauri/src-tauri/{tauri.conf.json,Cargo.toml}`
- `plugins/infra/plugins/endpoints/core/needs-machine.ts`, `plugins/auth/central/internal/handlers/oauth-start.ts`
- the MCP tool descriptions listed above; README.md, CLAUDE.md, docs/setup.md, CITATION.cff

## Verification

- `./equin check product-name:legacy` passes; temporarily adding a "<old>" line fails it.
- `./equin check` (all; includes `plugins-doc-in-sync`, `cli:legacy-cli-name`, `namespace:legacy-host`).
- `./equin test` on touched plugins: `infra/endpoints`, `infra/launcher/login-services`,
  `infra/codesign`, `page/markdown-apply`, `framework/tooling/guards`, `backup/targets/google-drive`
  (add a unit test for the folder resolution: new exists / only legacy → renamed / neither → created,
  with a stubbed fetch).
- `./equin build`, then in the agent browser: tab title reads "… — equin", Stats → Cost toggle
  reads "equin only", File explorer place reads "equin"; `rg --pcre2 '\bSingularity\b(?!-[A-Z])'`
  over the built `web` output is empty.
- `bash -n install.sh`, and `./equin doctor` prints "equin prerequisites: …".
