# Conversation DB schema

## Context

Today, the conversation list is derived live from `tmux list-sessions` in `plugins/conversations/server/internal/tmux.ts`. Nothing about a conversation survives after its tmux session ends — no status, no title history, no record of what the agent pushed.

We want conversations to become first-class persisted entities so we can:

- Keep completed/obsolete conversations visible after tmux dies.
- Track a lifecycle status (starting → working → needs attention → completed / obsolete).
- Record every successful `./equin push` from a session.

This schema is the foundation. Wiring status transitions and push recording are follow-up tasks.

## Architecture

The `plugins/conversations/` plugin already unifies the domain after the preceding refactor:

```
plugins/conversations/
  server/                         # shared server code (already exists)
    index.ts
    internal/{tmux.ts, db-fork.ts}
  shared/types.ts
  plugins/
    conversation-view/            # single pane + toolbar sub-plugins
    conversations-view/           # sidebar list
```

This task adds DB persistence inside `plugins/conversations/server/`:

- **New** `plugins/conversations/server/schema.ts` — drizzle schema (this task).
- **Modified** `plugins/conversations/server/internal/tmux.ts` — `listConversations` / `createConversation` / `deleteConversation` read/write the DB; live tmux state is joined in on read.
- **Modified** `plugins/conversations/server/index.ts` — re-export new DB-backed APIs if needed by the inner view plugins.

Inner view plugins (`conversation-view`, `conversations-view`) keep importing from `@plugins/conversations/server` and `@plugins/conversations/shared/types` — no path changes on their side.

## Schema

File: `plugins/conversations/server/schema.ts`

```ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),            // tmux session name, e.g. "claude-1776079015"
  worktree: text("worktree").notNull(),   // same as id for now; kept explicit for future decoupling
  title: text("title"),                    // mirror of cleaned tmux pane_title; null when idle
  status: text("status").notNull().default("starting"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const pushes = pgTable("pushes", {
  id: text("id").primaryKey(),                // nanoid / ulid
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  sha: text("sha").notNull(),                 // merge commit on main
  message: text("message").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

### Status — why plain `text`, not enum or lookup table

User flagged the status vocabulary is unstable (will rename, add, remove values). Trade-offs:

- **pgEnum**: adding values is easy, renaming works, but *removing* requires a full type rebuild migration — painful during churn.
- **Lookup table**: avoids enum migrations but forces a join and still needs data migrations for renames.
- **Plain `text` + TS union** *(recommended)*: zero DB friction while the vocabulary churns. The type lives in TS:
  ```ts
  export type ConversationStatus =
    | "starting" | "working" | "needs_attention" | "completed" | "obsolete";
  ```
  All writes go through the db plugin, so the TS type is the enforcement boundary. Once stable, promote to `pgEnum` in a later migration.

Register the barrel: add `export * from "@plugins/conversations/server/schema";` to `server/src/db/schema.ts`.

## Migration

1. Edit schemas, run `./equin build` — drizzle-kit generates `server/src/db/migrations/000X_*.sql`.
2. Server applies it on restart (see `server/src/db/migrate.ts`).
3. Commit the generated SQL alongside the schema change (enforced by `./equin check --migrations-in-sync`).

## Files touched

- **New**: `plugins/conversations/server/schema.ts`.
- **Modified**: `server/src/db/schema.ts` (add barrel export), `plugins/conversations/server/internal/tmux.ts` (DB writes on create/delete; DB reads on list), `plugins/conversations/shared/types.ts` (add `status`, `title`, `ConversationStatus` union).

Out of scope for this plan (follow-ups):

- Status transition triggers (who sets `working` / `needs_attention`).
- Hooking `./equin push` in `cli/src/commands/push.ts` to insert a `pushes` row.
- Title refresh loop.

## Verification

1. `./equin build` — confirm a new migration file is generated and applied without error.
2. `./equin check --migrations-in-sync` passes.
3. Open `http://<worktree>.localhost:9000`, create a conversation from the UI — row appears in `conversations` with `status = "starting"`.
4. `psql` the worktree DB, `SELECT * FROM conversations;` returns the created row; `DELETE FROM conversations` cascades to `pushes`.
5. Delete the conversation from UI — tmux session killed; row remains (status updated by follow-up work, not this task).
