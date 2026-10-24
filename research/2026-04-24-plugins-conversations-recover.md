---
date: 2026-04-24
category: plugins
title: conversations-recover plugin
status: draft
---

# conversations-recover plugin

## Context

When the host machine crashes (laptop sleep, OOM, tmux daemon death, or full server restart), the `conversations` poller correctly transitions all live sessions to `status='gone'` on the next tick, with `endedAt` stamped to the same instant. This produces a recoverable signature — a *cluster* of `gone` transitions sharing a near-identical timestamp — but today the user has no surface that highlights it. They have to know to inspect `/api/conversations/gone` and `claude --resume` each session by hand via the existing per-conversation `resume` button.

We want a **thin recovery UI** that lists recently-closed conversations grouped by close time, with per-row and group-batch **Restore** buttons. The user's eyes do the cluster identification — no heuristics, no thresholds, no automatic notification surface. A future iteration can layer auto-detection on top once this pane has bedded in.

Out of scope (deliberately deferred):
- Auto-detecting mass-kill clusters from the poller.
- Emitting a `ConversationsDied` event via the events plugin.
- Toasts / passive banners / `Core.Root` watchers.
- Any acknowledgement state (no config fields at all).
- Auto-restoring on boot (user explicitly does not want this).
- Replacing the existing per-conversation `resume` button.

## Design

### Plugin location & shape

New top-level plugin: `plugins/conversations-recover/`
- `web/` — sidebar entry + recovery pane.
- `server/` — batch-restore HTTP endpoint.

No `shared/` (nothing to share cross-runtime). No new DB tables. No config.

### Data flow

**Reading recently-gone conversations.** Reuse `GET /api/conversations/gone` from the `conversations` plugin (`plugins/conversations/server/internal/handle-list-gone.ts`). Returns `{ items: Conversation[], hasMore }` ordered by `endedAt` desc, with `before` (ISO) required and `limit` (default 20, max 50). The `Conversation` row already includes `endedAt` (set by the poller at lines 93 & 137 of `plugins/conversations/server/internal/poller.ts`), so grouping is a pure client-side operation: bucket consecutive rows whose `endedAt` differ by less than 1 second.

**Restore (single).** Reuse the existing per-conversation flow: `POST /api/conversations/:id/resume` in the `resume` plugin, which calls `resumeConversation(id)` from `plugins/conversations/server/internal/lifecycle.ts:111`. That helper is already a public export of `@plugins/conversations/server`.

**Restore (batch).** New endpoint `POST /api/conversations-recover/restore-batch` accepting `{ ids: string[] }`. Implementation calls `resumeConversation(id)` directly via `import { resumeConversation } from "@plugins/conversations/server"` — no HTTP self-call. Returns `{ results: Array<{ id, ok: boolean, error?: string }> }`. Failures are per-row (one bad session does not block the others). Calls `recentConversationsResource.notify()` once at the end (mirrors what the single-resume handler does).

### Recovery pane

`Pane.define()` from `@plugins/primitives/plugins/pane/web`:

```ts
export const recoveryPane = Pane.define({
  id: "conversations-recover",
  path: "/recovery",
  component: RecoveryView,
});
```

`RecoveryView` fetches `/api/conversations/gone?before=<now>&limit=50` and renders rows grouped by `endedAt` (1s buckets). Each cluster header shows `<HH:MM:SS> — <N> conversations closed` plus a `Restore all (N)` button. Each row shows the conversation's title, model, and a per-row `Restore` button. Single-row clusters omit the cluster header and just show the row with its per-row Restore button. The pane subscribes to `recentConversationsResource` so that resumed conversations disappear from the list on the next poller tick without a manual refresh.

Sidebar contribution:

```ts
Shell.Sidebar({
  title: "Recovery",
  icon: MdRestore,
  group: "System",
  onClick: () => recoveryPane.open({}),
}),
```

## Files to create

```
plugins/conversations-recover/
├── package.json                              # @singularity/plugin-conversations-recover
├── server/
│   ├── index.ts                              # barrel: definePlugin(...) + httpRoutes
│   └── internal/
│       └── handle-restore-batch.ts           # POST /api/conversations-recover/restore-batch
└── web/
    ├── index.ts                              # barrel: definePlugin(...) — Sidebar + Pane
    ├── pane.ts                               # Pane.define(recoveryPane)
    └── components/
        └── recovery-view.tsx                 # The pane: fetch + group + restore buttons
```

## Files to modify

- `web/src/plugins.ts` — add `import conversationsRecoverPlugin from "@plugins/conversations-recover/web"` and append to the plugins array.
- `server/src/plugins.ts` — same for the server side.

`docs/plugins.md` is **auto-generated** by `./equin build` (via `cli/src/checks/plugins-doc-in-sync.ts`). Do not hand-edit; rebuild and commit the generated diff.

## Plugin boundary compliance

- Both barrels (`web/index.ts`, `server/index.ts`) contain only imports, re-exports, type aliases, and a single `export default { ... } satisfies PluginDefinition`. No const/let/logic. Match the pattern from `plugins/crashes/web/index.ts` and `plugins/crashes/server/index.ts`.
- Cross-plugin imports use `@plugins/<name>/{web,server,shared}` only. Specifically:
  - `web/components/recovery-view.tsx` imports `Shell` from `@plugins/shell/web`, `Pane` from `@plugins/primitives/plugins/pane/web`, and types + `recentConversationsResource` from `@plugins/conversations/web` (or `@plugins/tasks-core/shared` for `Conversation`).
  - `server/internal/handle-restore-batch.ts` imports `resumeConversation` and `recentConversationsResource` from `@plugins/conversations/server` / `@plugins/tasks-core/server`.
- No new edges from other plugins into `conversations-recover`. To verify after writing, run `./equin check --plugin-boundaries`.

## Reused primitives — do not reimplement

| Need | Existing primitive | Source |
|---|---|---|
| List recently-gone conversations | `GET /api/conversations/gone` | `plugins/conversations/server/internal/handle-list-gone.ts` |
| Resume one conversation | `resumeConversation(id)` | `plugins/conversations/server/internal/lifecycle.ts:111` (public via `@plugins/conversations/server`) |
| UI tick on conversation state changes | `recentConversationsResource` push resource | `@plugins/tasks-core/server` (consumed web-side via `@plugins/conversations/web`) |
| Sidebar entry | `Shell.Sidebar({ title, icon, group, onClick })` | example: `plugins/tasks/web/index.ts` |
| Pane | `Pane.define({ id, path, component })` from `@plugins/primitives/plugins/pane/web` | example: `plugins/welcome/web/panes.ts` |

## Verification

After implementation, run `./equin build` from the worktree directory, then:

1. **Pane renders.** Open `http://<worktree>.localhost:9000/recovery` (or via the new Recovery sidebar entry). Confirm rows from `/api/conversations/gone` appear, ordered by `endedAt` desc, grouped within 1s buckets, with per-row and per-cluster `Restore` buttons. Single-row clusters show no cluster header.
2. **Single-row restore works.** Click `Restore` on a single row of a known-recoverable gone conversation. Confirm via the conversations sidebar / tmux (`tmux list-sessions`) that the session is back. Should be functionally identical to clicking the existing per-conversation `resume` button.
3. **Batch restore.** Stage a cluster: kill two tmux sessions quickly (`tmux kill-session -t <id1>; tmux kill-session -t <id2>`), wait for the 1s poller tick, then open the recovery pane. Click `Restore all` on the cluster header. Confirm both come back. Confirm the response surfaces per-row `{ ok: false, error }` entries if any one fails.
4. **Live refresh on restore.** With the pane open, click `Restore` on a row — the row should disappear within ~1s (via the `recentConversationsResource` subscription) without a manual refresh.
5. **Plugin boundaries.** Run `./equin check --plugin-boundaries`. Must pass.
6. **Docs in sync.** Run `./equin check --plugins-doc-in-sync` after `./equin build`. Must pass; commit the regenerated `docs/plugins.md`.
