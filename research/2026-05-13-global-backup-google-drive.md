# Backup System with Google Drive Integration

## Context

The only backup mechanism today is `plugins/debug/plugins/db-backup/` — a debug tool that dumps the Postgres DB to `~/.backups/singularity/`. It has no scheduling, no Google Drive upload, and doesn't back up secrets or attachments. If the computer is lost, everything is gone.

This plan introduces a proper backup system as a top-level umbrella plugin with pluggable storage targets. It backs up DB + secrets + attachments, bundles them into a `.tar.gz` archive, and dispatches to registered targets (local filesystem, Google Drive). Scheduling is manual or periodic (daily default).

## Architecture

```
plugins/backup/
├── core/index.ts                     # BackupManifest, BackupArchive, BackupTargetResult types
├── shared/config.ts                  # backupConfig: periodicIntervalHours (default 24)
├── server/
│   ├── index.ts                      # ServerPluginDefinition: job, routes, config, onReady
│   └── internal/
│       ├── contribution.ts           # BackupTarget = defineServerContribution("backup.target")
│       ├── backup-job.ts             # defineJob("backup.run") — orchestrator
│       ├── assemble-archive.ts       # Stage files + tar.gz
│       ├── handle-run.ts             # POST /api/backup/run → job.enqueue
│       ├── handle-list.ts            # GET /api/backup/runs → list run rows
│       └── tables.ts                 # backup_runs table
├── web/
│   ├── index.ts                      # DebugApp.Sidebar entry, Pane.Register
│   ├── panes.ts                      # backupPane definition
│   └── components/backup-panel.tsx   # UI: run button, history, target results
└── plugins/
    ├── local/
    │   ├── shared/config.ts          # localBackupConfig: enabled (true), keepLast (10)
    │   ├── server/index.ts           # BackupTarget({ id: "local", run })
    │   └── web/index.ts              # Config.Spec(localBackupConfig)
    └── google-drive/
        ├── shared/config.ts          # googleDriveBackupConfig: enabled, keepLast (10)
        ├── server/
        │   ├── index.ts              # BackupTarget({ id: "google-drive", run })
        │   └── internal/
        │       ├── upload.ts         # Resumable upload to Drive via REST
        │       ├── folder.ts         # Ensure "equin Backups" folder exists
        │       └── retention.ts      # Delete oldest files beyond keepLast
        └── web/index.ts              # Config.Spec, connect CTA
```

Additionally, a prerequisite auth bridge:

```
plugins/auth/
├── central/
│   ├── index.ts                      # MODIFIED: add "POST /api/auth/token" route
│   └── internal/handlers/token.ts    # NEW: handler calling getAccessTokenInternal
└── server/
    ├── index.ts                      # MODIFIED: export getTokenFromCentral
    └── internal/get-token.ts         # NEW: HTTP client to POST /api/auth/token
```

## Prerequisite: Auth Token Bridge

The Google Drive target runs on the worktree server but needs an OAuth token from central. Today there's no way for worktree plugins to get auth tokens — the auth CLAUDE.md explicitly says "we add the helper when one does."

### Central side

Add `POST /api/auth/token` to `plugins/auth/central/index.ts`. The handler calls the existing `getAccessTokenInternal()` (which returns `TokenResponse = TokenSuccess | TokenNeedsConsent | TokenFailure`) and returns it as JSON. No new types needed.

**File:** `plugins/auth/central/internal/handlers/token.ts`

```ts
export const handleGetToken: HttpHandler = async (req) => {
  const body = await req.json();
  const result = await getAccessTokenInternal(body);
  return Response.json(result);
};
```

Since `/api/auth/*` is already in `central-routes.json`, no gateway changes needed.

### Worktree side

Add `getTokenFromCentral()` to `plugins/auth/server/`. This follows the exact secrets `postJson` pattern (`plugins/infra/plugins/secrets/server/internal/operations.ts`): POST to `http://localhost:9000/api/auth/token`, one retry with 250ms delay, typed error on 502/503/504.

**File:** `plugins/auth/server/internal/get-token.ts` — returns `TokenResponse` from `@plugins/auth/core`.

Export from `plugins/auth/server/index.ts` alongside the existing `Config.Field` contribution. Note: `plugins/auth/plugins/google/server/index.ts` already exists as a Config.Field stub — the new `getTokenFromCentral` lives in the **parent** `plugins/auth/server/`, not the google sub-plugin.

**Key types** (already defined in `plugins/auth/central/internal/token-access.ts`, re-export from `plugins/auth/core`):
- `TokenResponse = TokenSuccess | TokenNeedsConsent | TokenFailure`
- `GetAccessTokenArgs = { providerId, accountId?, scopes? }`

These types need to be exported from `@plugins/auth/core` so both central and server barrels can use them without circular imports.

## Storage Target Extension

A `defineServerContribution` named `"backup.target"`. Each target sub-plugin contributes via its `contributions:` array. The orchestrator calls `BackupTarget.getContributions()` at job-run time.

**File:** `plugins/backup/server/internal/contribution.ts`

```ts
export const BackupTarget = defineServerContribution<{
  id: string;
  name: string;
  run: (archive: BackupArchive) => Promise<BackupTargetResult>;
}>("backup.target");
```

Exported from `plugins/backup/server/index.ts`.

## Backup Job Flow

**`plugins/backup/server/internal/backup-job.ts`** — `defineJob("backup.run")`

1. Insert a `backup_runs` row (status: "running")
2. Call `assembleArchive(trigger)` — stages files into temp dir, creates tar.gz
3. Call `BackupTarget.getContributions()`, invoke each target's `run(archive)` in parallel
4. Update the run row with results (status: "ok" | "partial" | "failed")
5. If trigger is "periodic", re-enqueue with `jobKey: "backup.periodic"` and `runAt: now + intervalHours`

Target failures don't throw — they return `{ ok: false, detail }`. The job succeeds and records per-target results. Only archive assembly failures fail the job.

## Archive Assembly

**`plugins/backup/server/internal/assemble-archive.ts`**

Stages into `~/.backups/singularity/YYYY-MM-DD_HH-MM-SS/staging/`:

```
staging/
  manifest.json
  db/singularity.dump          # pg_dump -Fc (via backupDatabase from @plugins/database/plugins/admin/server)
  secrets/secrets.json.enc     # copy of STORE_PATH
  secrets/.key                 # copy of KEY_PATH (skip if missing — macOS keychain primary)
  attachments/                 # recursive copy of ATTACHMENTS_DIR (skip if missing)
```

Then `tar -czf archive.tar.gz -C staging .`

Reuses existing imports:
- `backupDatabase`, `listDatabases` from `@plugins/database/plugins/admin/server`
- `BACKUPS_DIR`, `STORE_PATH`, `KEY_PATH`, `ATTACHMENTS_DIR` from `@plugins/infra/plugins/paths/server`

Filter: only non-worktree DBs (exclude `claude-*`, `att-*`), same as today.

## Manifest

```ts
// plugins/backup/core/index.ts
export interface BackupManifest {
  version: 1;
  createdAt: string;              // ISO 8601
  trigger: "manual" | "periodic";
  sources: {
    databases: string[];
    secretsIncluded: boolean;
    attachmentsIncluded: boolean;
  };
  sizeBytes: number;
}
```

## Database Schema

```ts
// plugins/backup/server/internal/tables.ts
export const _backupRuns = pgTable("backup_runs", {
  id: text("id").primaryKey(),
  trigger: text("trigger").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull().default("running"),
  archiveSizeBytes: integer("archive_size_bytes"),
  manifest: jsonb("manifest"),
  targetResults: jsonb("target_results"),
});
```

## Config Fields

**`plugins/backup/shared/config.ts`** (orchestrator):

```ts
export const backupConfig = defineConfig({
  periodicIntervalHours: {
    default: 24,
    label: "Backup interval (hours)",
    description: "How often to run automatic backups. 0 = manual only.",
  },
});
```

**`plugins/backup/plugins/local/shared/config.ts`**:

```ts
export const localBackupConfig = defineConfig({
  enabled: { default: true, label: "Enable local backup" },
  keepLast: { default: 10, label: "Keep last N local backups" },
});
```

**`plugins/backup/plugins/google-drive/shared/config.ts`**:

```ts
export const googleDriveBackupConfig = defineConfig({
  enabled: { default: false, label: "Enable Google Drive backup" },
  keepLast: { default: 10, label: "Keep last N Drive backups" },
});
```

## Local Target

**`plugins/backup/plugins/local/server/index.ts`**

`run(archive)`:
1. The archive is already on disk (assembled by orchestrator into `BACKUPS_DIR/<timestamp>/`)
2. Read config `keepLast`
3. List all timestamped dirs in `BACKUPS_DIR`, sort newest-first, delete dirs beyond `keepLast`
4. Return `{ targetId: "local", ok: true, detail: archive.archivePath }`

## Google Drive Target

**`plugins/backup/plugins/google-drive/server/index.ts`**

`run(archive)`:
1. Read config — if `!enabled`, return `{ ok: true, detail: "disabled" }`
2. Call `getTokenFromCentral({ providerId: "google", scopes: ["https://www.googleapis.com/auth/drive.file"] })`
3. If `!result.ok && result.needsConsent` → return `{ ok: false, needsConsent: true, detail: "Google account not connected or missing Drive scope" }`
4. Ensure folder exists (`folder.ts`) — search for "equin Backups" folder, create if missing, cache the folderId
5. Resumable upload (`upload.ts`) — initiate session, stream the tar.gz
6. Retention (`retention.ts`) — list files in folder by `createdTime`, delete oldest beyond `keepLast`
7. Return `{ ok: true, detail: webViewLink }`

### Upload flow (`upload.ts`)

```
POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable
  Authorization: Bearer <token>
  Content-Type: application/json
  X-Upload-Content-Type: application/gzip
  Body: { name: "singularity-backup-YYYY-MM-DD_HH-MM-SS.tar.gz", parents: [folderId] }
→ Location: <uploadUrl>

PUT <uploadUrl>
  Content-Type: application/gzip
  Body: file stream
→ { id, webViewLink }
```

Uses raw `fetch` — no `googleapis` npm dependency.

### Folder management (`folder.ts`)

```
GET https://www.googleapis.com/drive/v3/files
  ?q=name='equin Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false
  &fields=files(id)
```

If empty, create:
```
POST https://www.googleapis.com/drive/v3/files
  Body: { name: "equin Backups", mimeType: "application/vnd.google-apps.folder" }
```

Cache folderId in-memory (reset on server restart).

### Retention (`retention.ts`)

```
GET https://www.googleapis.com/drive/v3/files
  ?q='<folderId>' in parents and trashed=false
  &orderBy=createdTime
  &fields=files(id,name,createdTime)
```

Delete files beyond `keepLast`:
```
DELETE https://www.googleapis.com/drive/v3/files/<fileId>
```

## Scheduling

**Manual**: `POST /api/backup/run` → `backupRunJob.enqueue({ trigger: "manual" })`

**Periodic**: In `onReady` (guarded by `isMain()`):
```ts
const { periodicIntervalHours } = await readConfig(backupConfig);
if (periodicIntervalHours > 0) {
  await backupRunJob.enqueue(
    { trigger: "periodic" },
    { jobKey: "backup.periodic" }  // collapses duplicates
  );
}
```

At the end of a periodic run, the job re-enqueues itself:
```ts
await backupRunJob.enqueue(
  { trigger: "periodic" },
  { jobKey: "backup.periodic", runAt: new Date(Date.now() + intervalHours * 3_600_000) }
);
```

## Web UI

Under the debug app sidebar (replacing db-backup):

- **Sidebar entry**: icon `MdBackup`, label "Backup"
- **Pane**: `Pane.define({ id: "backup", segment: "debug/backup" })`
- **Panel components**:
  - "Run Backup Now" button → `POST /api/backup/run`
  - Last run status card (time, size, duration, per-target results)
  - Backup history list (from `GET /api/backup/runs`)
  - Per-target result indicators (local: path, Drive: link or "Connect Google" CTA)
  - Config link to Settings for interval/retention

The "Connect Google" CTA calls `startConnectFlow({ providerId: "google", scopes: ["drive.file"] })` from `@plugins/auth/web`.

## Migration from debug/db-backup

1. Delete `plugins/debug/plugins/db-backup/` entirely
2. Remove from `server/src/plugins.generated.ts` and `web/src/plugins.generated.ts`
3. Add new backup plugins to both generated files
4. Old backups in `~/.backups/singularity/` remain on disk but aren't surfaced in the new UI (different directory structure: old = `<timestamp>/<db>.dump`, new = `<timestamp>/archive.tar.gz`)

## Implementation Phases

### Phase 1: Auth Bridge

1. Move `TokenResponse`, `TokenSuccess`, `TokenNeedsConsent`, `TokenFailure`, `GetAccessTokenArgs` types to `plugins/auth/core/` so both central and server can import them
2. Create `plugins/auth/central/internal/handlers/token.ts` — handler calling `getAccessTokenInternal()`
3. Add `"POST /api/auth/token": handleGetToken` to `plugins/auth/central/index.ts`
4. Create `plugins/auth/server/internal/get-token.ts` — HTTP client following secrets `postJson` pattern
5. Export `getTokenFromCentral` from `plugins/auth/server/index.ts`

**Verify**: `./equin build`, then `curl -s -X POST http://localhost:9000/api/auth/token -H 'Content-Type: application/json' -d '{"providerId":"google"}'` returns a `TokenResponse` JSON.

### Phase 2: Core + Orchestrator + Local Target

1. Create `plugins/backup/core/index.ts` — types
2. Create `plugins/backup/shared/config.ts` — backupConfig
3. Create `plugins/backup/server/internal/contribution.ts` — BackupTarget
4. Create `plugins/backup/server/internal/tables.ts` — backup_runs
5. Create `plugins/backup/server/internal/assemble-archive.ts` — port + extend from handle-backup.ts
6. Create `plugins/backup/server/internal/backup-job.ts` — orchestrator
7. Create `plugins/backup/server/internal/handle-run.ts` — POST route
8. Create `plugins/backup/server/internal/handle-list.ts` — GET route
9. Create `plugins/backup/server/index.ts` — wire everything
10. Create `plugins/backup/plugins/local/` — target + config
11. Register all server plugins

**Verify**: `./equin build`, `curl -X POST http://localhost:9000/api/backup/run`, check `~/.backups/singularity/` for archive.

### Phase 3: Google Drive Target

1. Create `plugins/backup/plugins/google-drive/shared/config.ts`
2. Create `plugins/backup/plugins/google-drive/server/internal/folder.ts`
3. Create `plugins/backup/plugins/google-drive/server/internal/upload.ts`
4. Create `plugins/backup/plugins/google-drive/server/internal/retention.ts`
5. Create `plugins/backup/plugins/google-drive/server/index.ts`
6. Register server plugin

**Verify**: Connect Google with Drive scope, run backup, check Drive for file.

### Phase 4: Web UI + Cleanup

1. Create `plugins/backup/web/` — pane, sidebar entry, panel component
2. Create sub-plugin web files — Config.Spec contributions
3. Delete `plugins/debug/plugins/db-backup/`
4. Update all `plugins.generated.ts` files
5. `./equin build`

**Verify**: Open debug app, see Backup entry, run a backup from UI, check results render.

## Key Files to Read/Reference During Implementation

| File | Why |
|---|---|
| `plugins/debug/plugins/db-backup/server/internal/handle-backup.ts` | Port the backup logic |
| `plugins/debug/plugins/db-backup/web/components/db-backup-panel.tsx` | Port the UI |
| `plugins/database/plugins/admin/server/internal/backup.ts` | `backupDatabase`, `inspectBackup` |
| `plugins/infra/plugins/secrets/server/internal/operations.ts` | Canonical worktree→central HTTP pattern |
| `plugins/auth/central/internal/token-access.ts` | `getAccessTokenInternal`, `TokenResponse` types |
| `plugins/auth/central/index.ts` | Where to add the token route |
| `plugins/infra/plugins/paths/server/internal/paths.ts` | `BACKUPS_DIR`, `STORE_PATH`, `KEY_PATH`, `ATTACHMENTS_DIR`, `isMain` |
| `plugins/tasks/server/index.ts` | Reference for `defineJob` + `Trigger` + `register` pattern |
| `plugins/conversations/plugins/conversation-category/server/` | Reference for job + event wiring |
| `server/src/contributions.ts` | `defineServerContribution` |
