---
title: Haiku-generated task titles for improve & new-child-task
date: 2026-04-29
category: tasks-core
---

# Context

Both task-creation popups in the app — the **improve** form and the **new-child-task** popover — currently mishandle the user's prompt:

- `improve` (server `plugins/improve/server/internal/handle-submit.ts:31-36`) takes the first line of the prompt, truncates to 80 chars, and uses that as the **title**. The full prompt becomes the description.
- `new-child-task` (client `plugins/conversations/.../new-child-task-action.tsx:31-46`) posts the textarea value verbatim as the **title**. No description is set, so the prompt becomes the title outright (often a long sentence of intent).

The result is task lists full of long, awkward titles that read like prompts, with empty or duplicated description fields.

The fix: the prompt is description-shaped content; treat it as such. The title should be a short, summary-shaped string generated from the prompt by **Haiku**.

Constraints learned during research:

- The codebase has **no Anthropic SDK** dependency and no API-key plumbing. All existing LLM calls go through `createConversation()` → Claude CLI in tmux.
- There is **no existing synchronous "run a quick prompt and get text back" primitive**.
- The `summary` plugin's pattern is fire-and-forget Sonnet-via-tmux + MCP callback — too heavy for a 1-2 word title.

User-confirmed design choices:

1. **Call Haiku via `claude --print`** (not the SDK). Reuses the user's existing Claude CLI auth, no new dependency, no API key.
2. **Block on Haiku's response** before inserting the task. ~1-2s UI delay is acceptable for a one-time create action.
3. **Fall back to first-line-80-chars** (current `synthesiseTitle` logic) on any Haiku error/timeout, so task creation never fails because Haiku is unavailable.

# Plan

## 1. New infra primitive: `plugins/infra/plugins/claude-cli/`

A small server-only plugin exposing a one-shot Claude CLI call.

**`plugins/infra/plugins/claude-cli/server/index.ts`** (barrel) re-exports:

```ts
export { runClaudePrint } from "./internal/run-claude-print";
export type { ClaudePrintModel, RunClaudePrintInput } from "./internal/run-claude-print";
```

**`plugins/infra/plugins/claude-cli/server/internal/run-claude-print.ts`**:

```ts
export type ClaudePrintModel = "haiku" | "sonnet" | "opus";

export interface RunClaudePrintInput {
  model: ClaudePrintModel;
  prompt: string;
  system?: string;
  timeoutMs?: number; // default 15_000
}

export async function runClaudePrint(input: RunClaudePrintInput): Promise<string>;
```

Implementation:
- Spawns `claude --print --model <full-model-id> [--append-system-prompt <system>]` via `Bun.spawn`.
- Pipes `prompt` to stdin; reads stdout; rejects on non-zero exit or timeout.
- Maps short alias → full ID: `haiku` → `claude-haiku-4-5-20251001`, `sonnet` → `claude-sonnet-4-6`, `opus` → `claude-opus-4-7`. (Aliases keep callers stable across model bumps; full IDs prevent CLI-side latest-channel surprises.)
- Throws `ClaudeCliError` on failure so callers can choose to swallow it.

The plugin has **no client surface** (no `web/`) — it's pure server infra. Register it in `server/src/plugins.ts`.

**`plugins/infra/plugins/claude-cli/CLAUDE.md`** documents the contract and warns: this is for short, latency-tolerant calls only. For real conversations, use `createConversation`.

## 2. Title-generation helper in `tasks-core`

**`plugins/tasks-core/server/internal/generate-title.ts`** (new):

```ts
import { runClaudePrint } from "@plugins/infra/plugins/claude-cli/server";

const SYSTEM_PROMPT = `You generate concise task titles. Given a task description, output a single short imperative title (max ~60 chars). No quotes, no trailing period, no extra commentary — just the title text.`;

export async function generateTaskTitle(description: string): Promise<string> {
  const fallback = synthesiseTitleFallback(description);
  if (!description.trim()) return fallback;
  try {
    const out = await runClaudePrint({
      model: "haiku",
      prompt: description,
      system: SYSTEM_PROMPT,
      timeoutMs: 10_000,
    });
    const cleaned = out.trim().replace(/^["']|["']$/g, "").split(/\r?\n/)[0]?.trim();
    if (!cleaned) return fallback;
    return cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned;
  } catch {
    return fallback;
  }
}

export function synthesiseTitleFallback(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? text;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}
```

Re-exported from `plugins/tasks-core/server/index.ts` as `generateTaskTitle` and `synthesiseTitleFallback`.

This consolidates the two existing duplicated copies of `synthesiseTitle` (one in `improve/handle-submit.ts:64-67`, one in `improve/lifecycle.ts:34-39`).

## 3. Wire into the **improve** plugin

**`plugins/improve/server/internal/handle-submit.ts`**:

- Remove the local `synthesiseTitle` function.
- Replace line 33 `title: synthesiseTitle(text)` with `title: await generateTaskTitle(text)`.
- The existing description-rendering logic (`renderTaskDescription`) is unchanged — already correct.

**`plugins/improve/server/internal/lifecycle.ts:34-39`**: replace its local `synthesiseTitle` with the imported `synthesiseTitleFallback` (this path is for naming initial conversation titles, not task titles, so it should keep using the cheap fallback rather than a Haiku call).

## 4. Wire into the **tasks** plugin's `POST /api/tasks` handler

**`plugins/tasks/server/internal/handle-create.ts`**:

- Update body schema:
  ```ts
  // Before: title is required
  // After:
  z.object({
    parentId: z.string().optional(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    autoStart: ...,
    dependencies: ...,
  }).refine(b => b.title || b.description, { message: "title or description required" })
  ```
- Resolve final values before calling `createTask`:
  ```ts
  const description = body.description?.trim() || null;
  const title = body.title?.trim()
    || (description ? await generateTaskTitle(description) : "Untitled");
  await createTask({ parentId, title, description, author, rank });
  ```
- Pass `description` through to `createTask` (the underlying mutation already accepts it; the handler just wasn't forwarding it).

## 5. Wire into the **new-child-task** popover client

**`plugins/conversations/plugins/conversation-view/plugins/new-child-task/web/components/new-child-task-action.tsx`** lines 31-40:

- Rename the local variable `title` → `description` to reflect what it is.
- Replace `title: title` in the POST body with `description: description`.
- The textarea placeholder/label may want a small wording update ("Describe the task…" instead of "Task title…") — do this in the same patch.

The server handler from step 4 will Haiku-generate the title from the description.

## 6. Files modified — summary

| File | Change |
|---|---|
| `plugins/infra/plugins/claude-cli/server/index.ts` | NEW — barrel |
| `plugins/infra/plugins/claude-cli/server/internal/run-claude-print.ts` | NEW — spawn helper |
| `plugins/infra/plugins/claude-cli/package.json` | NEW — workspace pkg |
| `plugins/infra/plugins/claude-cli/CLAUDE.md` | NEW — doc |
| `server/src/plugins.ts` | register new plugin |
| `plugins/tasks-core/server/internal/generate-title.ts` | NEW |
| `plugins/tasks-core/server/index.ts` | re-export `generateTaskTitle`, `synthesiseTitleFallback` |
| `plugins/improve/server/internal/handle-submit.ts` | use `generateTaskTitle`; drop local `synthesiseTitle` |
| `plugins/improve/server/internal/lifecycle.ts` | use shared `synthesiseTitleFallback` |
| `plugins/tasks/server/internal/handle-create.ts` | accept `description`, generate title when missing |
| `plugins/conversations/plugins/conversation-view/plugins/new-child-task/web/components/new-child-task-action.tsx` | send `description` instead of `title` |

# Verification

1. `./equin build` succeeds (typechecks, plugin-boundary checks, migrations clean).
2. **Improve flow:** open the improve popup, type a multi-sentence prompt, submit. Expected:
   - The new task's title is a short Haiku-generated summary (~5-10 words).
   - The full prompt is in the description field.
   - With Claude CLI logged out / `claude` not on PATH: title falls back to first-line-80-chars; task still gets created.
3. **New-child-task flow:** in the conversation toolbar, open the +child popover, type a multi-sentence prompt, click Create. Expected: same as above — Haiku title, full prompt as description.
4. **Direct API smoke test:** `curl -X POST http://singularity.localhost:9000/api/tasks -d '{"description":"refactor the gateway proxy to use a worker pool"}'` returns 200 with a Haiku-generated title.
5. **Failure path:** temporarily rename `claude` on PATH (or set `claudeCliPath` to a non-existent binary in a unit test); verify task creation still succeeds with the fallback title.
6. **Latency check:** improve / new-child-task submit-to-task-visible round trip is ≤3s on a normal machine.
