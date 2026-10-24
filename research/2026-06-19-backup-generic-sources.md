# Generic, pluggable backup sources

## Context

Today `plugins/backup/` hardcodes **what** it saves. `assemble-archive.ts` contains three inline blobs — DB dumps, secrets, attachments — and the engine knows about each one by name. The manifest mirrors this with a fixed `sources: { databases, secretsIncluded, attachmentsIncluded }` shape, and the backup pane only renders `N DB`. So:

- The UI shows almost nothing about what a backup contains (size + DB count).
- Adding a new thing to back up means editing the engine — the opposite of the collection-consumer separation rule the project enforces everywhere else.
- The **target** side is already generic (`BackupTarget` contribution, one sub-plugin per target). The **source** side never got the same treatment.

This change makes the source side symmetric with the target side: the engine becomes a pure orchestrator that loops registered `BackupSource` contributions and never names one. Each source is its own toggleable sub-plugin. We migrate the 3 existing blobs and add 5 new sources (config files, active-conversation transcripts, Claude settings, Singularity platform files, project memory). The manifest becomes a generic `sources[]` the UI renders without special-casing, and the backup pane gets a gear that opens the config page (reusing `ConfigGearButton`).

### Decisions (confirmed with user)

- **Layout:** introduce `plugins/backup/plugins/sources/<name>/` **and** `plugins/backup/plugins/targets/<name>/`; move the existing `local` / `google-drive` targets under `targets/` for symmetry.
- **Transcripts = active conversations only** — not the ~2GB of historical transcripts. Enumerate via `listActiveConversations()` + `findTranscriptPath()`.
- **Extra sources:** Claude platform settings, Singularity platform files, project memory — each its own sub-plugin.
- **Gear:** reuse `ConfigGearButton` to redirect to the config page (no custom toggle popover).

## Architecture

The engine gains a second generic contribution slot, `BackupSource`, mirroring `BackupTarget` exactly. `assembleArchive` becomes a loop over `BackupSource.getContributions()`, handing each source its own staging subdir and collecting a generic `BackupSourceReport`. Each source **self-gates** on its own `enabled` config (same pattern as `runLocalTarget`), so the engine never reads a source's config and never branches on an id. The manifest stores `sources: BackupSourceReport[]`; the UI renders it generically.

```
plugins/backup/
  core/index.ts            ← generic manifest + report types
  server/internal/
    contribution.ts        ← add BackupSource slot next to BackupTarget
    assemble-archive.ts    ← gut to a generic loop
  shared/endpoints.ts      ← permissive manifest Zod (v1 + v2)
  web/components/
    backup-panel.tsx       ← render sources[]; add gear button
  plugins/
    sources/{databases,secrets,attachments,config,transcripts,
             claude-settings,singularity-platform,project-memory}/
    targets/{local,google-drive}/   ← moved from plugins/{local,google-drive}
```

---

## Part A — Core types (`plugins/backup/core/index.ts`)

Replace the fixed `sources` object with a generic array. Bump manifest `version` to `2`.

```ts
export interface BackupSourceItem { label: string; detail?: string; count?: number }
export interface BackupSourceReport {
  id: string; name: string; skipped: boolean;
  items: BackupSourceItem[]; sizeBytes: number;
}
export interface BackupManifest {
  version: 2;
  createdAt: string;
  trigger: "manual" | "periodic";
  sources: BackupSourceReport[];   // was { databases, secretsIncluded, attachmentsIncluded }
  sizeBytes: number;
}
```

`BackupArchive` / `BackupTargetResult` unchanged.

## Part B — Server slot + generic engine

**`server/internal/contribution.ts`** — add next to `BackupTarget`:

```ts
import type { BackupSourceReport } from "@plugins/backup/core";
export const BackupSource = defineServerContribution<{
  id: string; name: string;
  assemble: (dir: string) => Promise<BackupSourceReport>;
}>("backup.source", { docLabel: (p) => p.name });
```

**`server/index.ts`** — `export { BackupSource, BackupTarget } from "./internal/contribution";` and update the plugin `description` (no longer "from DB, secrets, attachments").

**`server/internal/assemble-archive.ts`** — remove all imports of `STORE_PATH`/`KEY_PATH`/`ATTACHMENTS_DIR`/`listDatabases`/`backupDatabase`. New core:

```ts
const sources = BackupSource.getContributions();
const reports: BackupSourceReport[] = [];
for (const source of sources) {
  const dir = join(stagingDir, source.id);
  await mkdir(dir, { recursive: true });
  reports.push(await source.assemble(dir));   // engine never inspects contents or branches on id
}
const manifest: BackupManifest = { version: 2, createdAt: ..., trigger, sources: reports, sizeBytes: 0 };
// write manifest.json → tar -czf -C stagingDir . → stat → rewrite manifest → rm staging  (all unchanged)
```

**`server/internal/backup-job.ts`** — no logic change; the persisted `archive.manifest` now carries `sources[]`.

## Part C — Source sub-plugins

Each follows the 4-file `local` shape: `shared/config.ts` (`enabled` toggle), `server/internal/assemble-*.ts`, `server/index.ts` (`ConfigV2.Register` + `BackupSource({...})`), `web/index.ts` (`ConfigV2.WebRegister`). Each `assemble` self-gates: if `enabled` is false, return `{ id, name, skipped: true, items: [], sizeBytes: 0 }` — mirror the gating in `plugins/backup/plugins/local/server/internal/run-local-target.ts` (use the same server-side config read it uses).

| sub-plugin | default | copies | report items |
|---|---|---|---|
| `sources/databases` | on | `listDatabases()` minus `claude-*`/`att-*` → `backupDatabase(db, dir/<db>.dump)` | per db: `{label: db, detail: "N tables / M rows", count: tables}` via **`inspectBackup`** |
| `sources/secrets` | on | `STORE_PATH`→`secrets.json.enc`, `KEY_PATH`→`.key` (guard `existsSync`) | `{label:"secrets.json.enc", detail:"encrypted"}`, `{label:".key"}` |
| `sources/attachments` | on | recursive `cp ATTACHMENTS_DIR → dir` | `{label:"attachments", detail:"N files", count:N}` |
| `sources/config` | on | recursive `cp join(SINGULARITY_DIR,"config") → dir` | `{label:"config", detail:"N files", count:N}` |
| `sources/transcripts` | on | **active conversations only** (see below) | `{label:"transcripts", detail:"N conversations", count:N}` |
| `sources/claude-settings` | on | `~/.claude/{settings.json, history.jsonl, plugins/installed_plugins.json}` + `tasks/` + `teams/` | one item per file/dir copied |
| `sources/singularity-platform` | on | `SINGULARITY_DIR/{auth, database.json, crashes}` (guard each) | one item per entry |
| `sources/project-memory` | on | glob `~/.claude/projects/*/memory/` → copy each | `{label:"memory", detail:"N files", count:N}` |

**`sources/databases`** — `backupDatabase`, `listDatabases`, `inspectBackup` all come from the public barrel `@plugins/database/plugins/admin/server`. Per db: `const s = await inspectBackup(out, db); rows = s.tables.reduce((a,t)=>a+t.rowCount,0)`.

**`sources/transcripts`** — reuse the precedent in `plugins/conversations/plugins/transcript-retention/server/internal/touch-job.ts`:
```ts
import { listActiveConversations } from "@plugins/tasks/plugins/tasks-core/server";
import { findTranscriptPath } from "@plugins/conversations/plugins/transcript-watcher/server";
for (const conv of await listActiveConversations()) {
  if (!conv.claudeSessionId) continue;
  const path = await findTranscriptPath(conv.claudeSessionId);
  if (!path) continue;
  await cp(path, join(dir, basename(path)));
}
```
("active" = `status <> 'done'`, includes resumable `gone`.) Small, so default-on is safe.

**Path constants:** `SINGULARITY_DIR`, `ATTACHMENTS_DIR`, `STORE_PATH`, `KEY_PATH`, `CLAUDE_PROJECTS_DIR`, `HOME_DIR` are exported from `@plugins/infra/plugins/paths/server`. Add a `CLAUDE_DIR = join(HOME_DIR, ".claude")` export in `plugins/infra/plugins/paths/core/internal/paths.ts` (+ core/server barrels) for `claude-settings` / `project-memory` rather than recomputing.

> **Boundary note:** `CONFIG_DIR` is internal to config_v2 — the `config` source must NOT import it; it reconstructs the path from the public `SINGULARITY_DIR`.

## Part D — Move targets

Move `plugins/backup/plugins/local` → `plugins/backup/plugins/targets/local` and `plugins/backup/plugins/google-drive` → `plugins/backup/plugins/targets/google-drive`. Pure path move — their imports use barrels, and nothing imports them cross-plugin (only self `ConfigV2` registrations). `./equin build` regenerates the registries from the tree.

## Part E — Manifest Zod schema (`plugins/backup/shared/endpoints.ts`)

Legacy v1 rows already sit in `backup_runs.manifest` (jsonb). `listBackupRuns` returns the whole list, so one un-parseable row must not reject the response. Use a permissive union:

```ts
const sourceReport = z.object({ id: z.string(), name: z.string(), skipped: z.boolean(),
  items: z.array(z.object({ label: z.string(), detail: z.string().optional(), count: z.number().optional() })),
  sizeBytes: z.number() });
const manifest = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  createdAt: z.string(), trigger: z.enum(["manual","periodic"]),
  sources: z.union([z.array(sourceReport), z.object({}).passthrough()]), // v2 array | legacy v1 object
  sizeBytes: z.number() });
```
UI renders the Sources block only when `Array.isArray(manifest.sources)`.

## Part F — Web (`plugins/backup/web/components/backup-panel.tsx`)

1. **Gear button** in the panel header: `<ConfigGearButton descriptor={backupConfig} label="Backup settings" />` where `backupConfig` is the existing top-level config in `plugins/backup/shared/config.ts` (periodicCron). `useOpenConfig` opens that descriptor's detail page **with the config nav pane alongside**, where every `backup.*` config (each source's `enabled`, each target's `enabled`/`keepLast`, periodicCron) appears grouped under "Backup" as sibling rows the user can toggle. Ensure `backupConfig` is `ConfigV2.WebRegister`-ed in `plugins/backup/web/index.ts` (add if missing) so `useOpenConfig` can resolve it. `ConfigGearButton` is at `@plugins/config_v2/plugins/config-link/web`.
2. **`BackupRunRow`** — replace `run.manifest?.sources.databases.length` with a generic render: caption shows count of non-skipped sources; expanded section adds (before `targetResults`) a Sources block iterating `manifest.sources` (when an array) — per non-skipped report render `name` + each `item.label`/`item.detail`. Never special-case an id. `TargetResultRow` unchanged.
3. Update the descriptive paragraph (drop the hardcoded "database, secrets, attachments").

> Pre-existing wart (out of scope): `TargetResultRow` branches `targetId === "google-drive" ? MdCloudUpload : MdFolder` — an id check in the UI. Leave it; flag for a later cleanup (icon should come from the registration).

## Sequencing

1. Core types + `BackupSource` slot (A, B-slot).
2. Gut `assemble-archive.ts`; export `BackupSource` from server barrel (B).
3. `CLAUDE_DIR` path constant (C).
4. Migrate `databases`/`secrets`/`attachments` sources (so the engine has contributions before first run).
5. Move targets under `targets/` (D).
6. New sources: `config`, `transcripts`, `claude-settings`, `singularity-platform`, `project-memory` (C).
7. Permissive manifest Zod (E).
8. Gear + generic `sources[]` rendering in `backup-panel.tsx` (F).
9. `./equin build` — regenerates registries + docs + config origins. No SQL migration expected (`manifest` is untyped jsonb; the `$type<BackupManifest>` change is compile-time only).

## Boundary / correctness checklist

- Engine (`assemble-archive.ts`, `backup-job.ts`) uses ONLY `getContributions()` and never imports a source module or branches on `id` — collection-consumer separation honored.
- All cross-plugin imports go through public barrels (`paths/server`, `database/plugins/admin/server`, `tasks-core/server`, `conversations/plugins/transcript-watcher/server`, `config_v2/...`). No `shared/` or internal reach (esp. config_v2 `CONFIG_DIR`).
- `backup-job.ts` already catches per-step failures; a source that throws should fail loudly (let it propagate to the job's existing error handling — do not swallow). Self-gating returns `skipped`, it does not catch.
- Manifest version union prevents legacy rows from breaking `listBackupRuns`.

## Verification

1. `./equin build` (from the worktree) — confirm registries regenerate, no boundary/type-check failures (`./equin check`).
2. Open `http://att-1781886216-mesh.localhost:9000/debug/debug/backup`.
3. Click **Run Backup Now**; wait for the run row to reach `ok`. Expand it — confirm the Sources block lists databases (with "N tables / M rows"), secrets, attachments, config, transcripts ("N conversations"), claude-settings, singularity-platform, project-memory; and the Targets block as before.
4. Click the **gear** → confirm it lands on the Backup config page with the nav showing every source/target `enabled` toggle. Toggle a source off, run again, confirm that source shows `skipped` / is absent from the archive.
5. Inspect the archive on disk: `tar tzf ~/.backups/singularity/<ts>/archive.tar.gz` — confirm one top-level dir per enabled source id, and that disabled sources produced an empty/absent dir.
6. Cross-check transcript scope: `manifest.sources[transcripts].count` should equal the number of active conversations (`SELECT count(*) FROM conversations_v WHERE active` via `query_db`), not the full `~/.claude/projects` set.
7. Confirm a pre-existing v1 run row (if any) still renders without crashing the history list.
