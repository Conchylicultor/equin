# Conversation Summary Plugin

## Context

We need on-demand, structured progress metadata for each conversation — beyond the existing `working/blocked/done` status. Specifically: which *semantic phase* the conversation is in (clarification needed, design review, implementation review, etc.), anything to flag, and a recommended next action.

This metadata is the foundation for a future monitoring surface. The `yak-shaving` plugin currently mixes "summarization" with "tree curation" and is unsatisfying. The plan is to split those concerns: this new plugin owns *per-conversation summary generation and storage*; yak-shaving (or its successor) becomes a pure monitoring/dashboard view that reads this data.

V1 scope is intentionally narrow: a button in the conversation toolbar that triggers a Sonnet 4.6 summarization pass and writes an append-only row. No auto-regeneration, no monitoring UI yet — those come next.

## Design

### Plugin location & boundaries

New nested plugin: `plugins/conversations/plugins/summary/`. Importable from anywhere as `@plugins/conversations/plugins/summary/{web,server,shared}` (verified — yak-shaving already imports from comparable nested paths like `@plugins/conversations/plugins/conversation-view/web`).

Mirrors the structure of the closest reference, `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/`:
- `package.json` — `@singularity/plugin-conversations-summary`
- `web/index.ts` — barrel, default-exports `PluginDefinition`
- `web/components/summarize-button.tsx`
- `server/index.ts` — barrel, default-exports `ServerPluginDefinition`
- `server/internal/tables.ts` — Drizzle schema
- `server/internal/handle-generate.ts` — POST handler that spawns the system conversation
- `server/internal/mcp-tools.ts` — registers the `submit_conversation_summary` MCP tool
- `server/internal/prompt.ts` — builds the system-conversation prompt + context file
- `server/internal/resources.ts` — `defineResource` for `conversation-summaries`
- `shared/resources.ts` — `resourceDescriptor` + `Phase` enum + `ConversationSummary` Zod schema

### LLM call path

**Decision: spawn a system Sonnet conversation, expose an MCP tool for structured output.** Mirrors `plugins/yak-shaving/server/internal/handle-rebuild.ts:26`. Reuses Claude CLI auth (no `@anthropic-ai/sdk` dependency, no API-key plumbing). The codebase already uses MCP tools (`plugins/infra/plugins/mcp/server`) for structured agent output.

Flow:
1. Button click → `POST /api/conversation-summary/:conversationId/generate`
2. Handler reads transcript via `readConversationTurns(conversationId)` (exported from `@plugins/conversations/server`, returns parsed `Turn[]`) and task context via `getTask(taskId)` (from `@plugins/tasks-core/server`).
3. Handler writes context to `/tmp/singularity-summary-<convId>-<timestamp>.xml` (same trick yak-shaving uses to dodge tmux's ~16KB arg cap).
4. Handler calls `createConversation({ prompt, model: "sonnet", kind: "system", spawnedBy: "conversation-summary" })` with a prompt instructing Sonnet to read the context file and call `submit_conversation_summary` exactly once with the structured fields.
5. `setTimeout` schedules cleanup (`deleteConversation` + `unlink` the context file) after `CLEANUP_AFTER_MS = 5 * 60 * 1000`.
6. Returns `202 { conversationId, jobId }` immediately. Client subscribes to the `conversation-summaries` resource for the result.
7. When Sonnet calls the MCP tool, the tool inserts the row in `conversation_summaries`, calls `conversationSummariesResource.notify()`, which pushes the new row to all subscribers.

**MCP tool** (`server/internal/mcp-tools.ts`, registered via `Mcp.registerTool` like `plugins/yak-shaving/server/internal/mcp-tools.ts`):

```ts
Mcp.registerTool({
  name: "submit_conversation_summary",
  description: "Submit a structured summary of the target conversation.",
  inputSchema: z.object({
    conversationId: z.string().uuid(),
    phase: PhaseSchema,
    phaseDetail: z.string().max(500).optional(),
    flags: z.string().max(2000).optional(),
    nextAction: z.string().max(1000),
    notes: z.string().max(2000).optional(),
  }),
  handler: async (args, _ctx) => { /* insert row, notify resource */ },
});
```

The system conversation's MCP context will resolve `conversationId` via the prompt — Sonnet receives the target id in the prompt and passes it back through the tool call. (We do *not* try to derive it from the spawning conversation's identity — keeping it explicit makes the tool reusable and the contract testable.)

### Schema

`server/internal/tables.ts`:

```ts
export const _conversationSummaries = pgTable("conversation_summaries", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: text("conversation_id").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  model: text("model").notNull(),
  turnCountAtGeneration: integer("turn_count_at_generation").notNull(),
  phase: text("phase").$type<Phase>().notNull(),
  phaseDetail: text("phase_detail"),
  flags: text("flags"),
  nextAction: text("next_action").notNull(),
  notes: text("notes"),
}, (t) => ({
  byConversation: index("conversation_summaries_by_conversation").on(t.conversationId, t.generatedAt.desc()),
}));
```

Append-only — every successful generation inserts a new row. No FK to conversations (matching push-and-exit's procedural-cleanup style, since drizzle-kit loads `tables.ts` outside the Bun runtime and cross-module FKs complicate that path); rows for deleted conversations are tolerated and can be swept later if needed.

### Phase enum (Zod, in `shared/resources.ts`)

```ts
export const PhaseSchema = z.enum([
  "clarification_needed",
  "design_review",
  "implementation_review",
  "investigating",
  "executing",
  "other",
]);
export type Phase = z.infer<typeof PhaseSchema>;
```

`other` + `phaseDetail` is the escape hatch — model picks an enum value, optionally explains in `phaseDetail`. The enum is intentionally about *semantic phase* (orthogonal to `working/blocked/done` which lives on the conversation status).

### Resource

`server/internal/resources.ts` — `defineResource` with `mode: "push"`, loader returns `Record<conversationId, ConversationSummary[]>` (latest-first per conversation). The shared descriptor lives in `shared/resources.ts`:

```ts
export const conversationSummariesResource =
  resourceDescriptor<Record<string, ConversationSummary[]>>("conversation-summaries");
```

Web side calls `useResource(conversationSummariesResource)` and looks up by `conversation.id`.

### Web: button + chip

`web/components/summarize-button.tsx` contributes to `conversationPane.Actions` (the toolbar slot — same neighborhood as `ModelBadge`, `StatusBadge`, `TasksButton`):

```ts
contributions: [conversationPane.Actions({ component: SummarizeButton })]
```

Component states:
- **No summary yet**: small "Summarize" button.
- **Generating**: spinner + "Summarizing…" (driven by a local `isPending` state from the POST; the resource will deliver the result).
- **Has summary**: chip showing the latest `phase` (color-coded), with hover-popover detail (`flags`, `nextAction`, `notes`, `generatedAt`).
- **Stale**: if `latest.turnCountAtGeneration < currentTurnCount`, the chip shows a small "+N turns" indicator and clicking re-runs.

Errors (POST 4xx/5xx, or no result within ~3 minutes) surface via `Shell.Toast({ variant: "error", description })` from `@plugins/shell/web`.

Turn count comes from a transcript length count — call `readConversationTurns` server-side once at the time of POST to capture `turnCountAtGeneration`. The client can derive "current turn count" from whatever it already knows (the JSONL viewer plugin already surfaces this; if not trivially available we add a tiny `GET /api/conversation-summary/:id/turn-count` helper, but try without first).

### HTTP routes

- `POST /api/conversation-summary/:conversationId/generate` → spawns system conversation, returns `202 { conversationId, spawnedConversationId }`
- (No DELETE — append-only history; if pruning ever needed, add later.)

### Cross-plugin imports (verified legal)

From the new plugin:
- `@plugins/conversations/server` — `createConversation`, `deleteConversation`, `readConversationTurns`, `Turn`
- `@plugins/conversations/plugins/conversation-view/web` — `conversationPane`, `ConversationRecord`
- `@plugins/conversations/web` — `useConversation` (if needed in button)
- `@plugins/tasks-core/server` — `getTask`, `getConversation`
- `@plugins/infra/plugins/mcp/server` — `Mcp.registerTool`
- `@plugins/primitives/plugins/live-state/{web,shared}` — `useResource`, `resourceDescriptor`
- `@plugins/shell/web` — `Shell.Toast`
- `@core` — `PluginDefinition`
- `@server/types`, `@server/db/client` — `ServerPluginDefinition`, `db`

All deeper paths (`/internal/...`) are forbidden — barrel-only access.

## Critical files

**To create:**
- `plugins/conversations/plugins/summary/package.json`
- `plugins/conversations/plugins/summary/web/index.ts`
- `plugins/conversations/plugins/summary/web/components/summarize-button.tsx`
- `plugins/conversations/plugins/summary/server/index.ts`
- `plugins/conversations/plugins/summary/server/internal/tables.ts`
- `plugins/conversations/plugins/summary/server/internal/handle-generate.ts`
- `plugins/conversations/plugins/summary/server/internal/mcp-tools.ts`
- `plugins/conversations/plugins/summary/server/internal/prompt.ts`
- `plugins/conversations/plugins/summary/server/internal/resources.ts`
- `plugins/conversations/plugins/summary/shared/resources.ts`

**To modify:**
- `web/src/plugins.ts` — register the new web plugin (default-import + add to registry)
- `server/src/plugins.ts` — register the new server plugin

**Reference (read but don't modify):**
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/` — closest structural template
- `plugins/yak-shaving/server/internal/handle-rebuild.ts:26` — system-conversation spawn pattern
- `plugins/yak-shaving/server/internal/mcp-tools.ts` — MCP tool registration pattern
- `plugins/conversations/plugins/conversation-view/web/slots.ts` and `web/panes.ts` — slot signatures (`conversationPane.Actions`)
- `plugins/infra/plugins/mcp/server/index.ts` — MCP plugin barrel

## Prompt design (system conversation)

Inline in `server/internal/prompt.ts`. The prompt tells Sonnet:
1. The target `conversationId` it must summarize (passed back via the MCP tool call).
2. To read the context file at the absolute path provided.
3. The schema of `submit_conversation_summary` and what each field means (especially the phase enum semantics).
4. To call the tool exactly once, then exit.

The context file (XML, like yak-shaving) contains:
- The task title + description (`getTask`)
- The conversation status, model, kind
- The full transcript (turns, role-tagged); if very long, future versions can truncate, but v1 sends everything.

## Verification

End-to-end smoke test after `./equin build`:

1. Open `http://<worktree>.localhost:9000`, navigate to any active conversation.
2. Confirm the "Summarize" button appears in the conversation toolbar (right side, alongside `ModelBadge` / `StatusBadge`).
3. Click it. Button enters "Summarizing…" state. A new system conversation should appear in the meta-task area (parented under `SYSTEM_META_TASK_ID`).
4. Within ~30s, the chip should update to show the phase and other fields. Hover reveals `nextAction`, `flags`, `notes`.
5. Send another turn in the original conversation, then re-check the button: it should show a "+1 turns" stale indicator.
6. Click re-summarize; confirm a *new* row is created (don't overwrite) — verify in DB:
   ```sql
   SELECT phase, phase_detail, generated_at, turn_count_at_generation
   FROM conversation_summaries
   WHERE conversation_id = '<id>'
   ORDER BY generated_at DESC;
   ```
7. Confirm `./equin check` passes (plugin-boundaries + migrations-in-sync).
8. Confirm spawned system conversations are reaped after `CLEANUP_AFTER_MS` (or earlier on success).

Error path:
9. Force a failure (e.g., block the spawn) and confirm a `Shell.Toast` error appears in the UI.

## Out of scope (future work)

- Auto-regeneration on turn completion (would subscribe to `conversationTurnCompleted` event).
- Monitoring dashboard reading the resource (eventual yak-shaving replacement).
- Switching to Haiku 4.5 once we have a labeled set to A/B against Sonnet.
- Pruning old summary rows / FK cascade on conversation deletion.
- Truncating very long transcripts before sending to Sonnet.
