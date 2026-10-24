# Shared `retryUntil` primitive

## Context

The transcript-watcher refactor introduced a local `pollUntil` utility that cleanly expresses "retry until non-null." The same pattern exists in 3 other places with varying shapes. Extracting a shared primitive prevents the "forgot to retry" bug class and gives a composable API for timing strategies.

After reviewing all 4 call sites, only 1 is a clean migration candidate today. The others either live in the wrong layer (server bootstrap), are test infra, or don't fit the poll-until pattern. The primitive is still worth extracting — it's the canonical way to do this going forward, and transcript-watcher is the immediate consumer.

## API

```ts
// plugins/infra/plugins/retry/server/internal/retry-until.ts

export type DelayStrategy = (attempt: number) => number;

export async function retryUntil<T>(
  fn: () => Promise<T | null | undefined>,
  opts: { delay: DelayStrategy; signal?: AbortSignal; deadline?: number },
): Promise<T>;
```

Contract:
- `fn` returns non-null → resolved, return value
- `fn` returns null/undefined → not ready, retry after `delay(attempt)`
- `fn` throws → fatal, propagate immediately (caller handles error classification)
- `signal` aborted → throw `DOMException("Aborted", "AbortError")`
- `deadline` exceeded → throw `RetryDeadlineError` (exported, includes elapsed time)

### Strategy factories

```ts
// plugins/infra/plugins/retry/server/internal/strategies.ts

export const fixed = (ms: number): DelayStrategy => () => ms;

export const exponential = (opts?: { initial?: number; max?: number }): DelayStrategy =>
  (attempt) => Math.min((opts?.initial ?? 100) * 2 ** attempt, opts?.max ?? 10_000);

export const withJitter = (strategy: DelayStrategy, factor = 0.2): DelayStrategy =>
  (attempt) => strategy(attempt) * (1 + (Math.random() - 0.5) * factor);
```

### Barrel

```ts
// plugins/infra/plugins/retry/server/index.ts
export { retryUntil, type DelayStrategy, RetryDeadlineError } from "./internal/retry-until";
export { fixed, exponential, withJitter } from "./internal/strategies";
```

## Migration scope

### Migrate: transcript-watcher

Replace the local `pollUntil` with the shared `retryUntil`:

```ts
// Before (local pollUntil)
const sessionId = await pollUntil(
  () => getConversationClaudeSessionId(room.conversationId),
  { intervalMs: POLL_MS, signal },
);

// After
import { retryUntil, fixed } from "@plugins/infra/plugins/retry/server";

const sessionId = await retryUntil(
  () => getConversationClaudeSessionId(room.conversationId),
  { delay: fixed(1_000), signal },
);
```

Delete the local `pollUntil` function and the `POLL_MS` constant.

### Skip: `awaitPgReady` (server/src/db/client.ts)

Lives in server bootstrap code — runs before plugins load. Can't import from `@plugins/`. Also has singleton promise semantics (`readyPromise`) and the `isTransientPgError` predicate that the caller handles internally. Already works correctly.

### Skip: crash-recovery (events-test)

Test infrastructure for exercising the events plugin. Low value, and the inline `while + setTimeout` loop is 5 lines.

### Skip: secrets `postJson`

Different pattern entirely — "try once, on network error retry once, then throw a typed error." Not a poll-until-condition flow. The fn doesn't return null for "not ready", it throws. `retryUntil` would be a worse fit than the existing code.

## Implementation steps

1. **Create plugin structure:**
   ```
   plugins/infra/plugins/retry/
     CLAUDE.md
     package.json
     server/
       index.ts
       internal/
         retry-until.ts
         strategies.ts
   ```

2. **Implement `retryUntil`** in `retry-until.ts` (~25 lines):
   - Loop while not aborted and not past deadline
   - Call fn, return if non-null
   - Sleep `delay(attempt)`, increment attempt
   - Export `RetryDeadlineError` class

3. **Implement strategies** in `strategies.ts` (~10 lines):
   - `fixed`, `exponential`, `withJitter`

4. **Register in workspace** — add to root `package.json` workspaces if needed (check if glob already covers it).

5. **Migrate transcript-watcher** — replace local `pollUntil` + `POLL_MS` with import from `@plugins/infra/plugins/retry/server`.

6. **Update plugin docs** — `./equin build` regenerates `plugins-compact.md` and `plugins-details.md`.

## Files to create/modify

- **Create:** `plugins/infra/plugins/retry/server/internal/retry-until.ts`
- **Create:** `plugins/infra/plugins/retry/server/internal/strategies.ts`
- **Create:** `plugins/infra/plugins/retry/server/index.ts`
- **Create:** `plugins/infra/plugins/retry/package.json`
- **Create:** `plugins/infra/plugins/retry/CLAUDE.md`
- **Modify:** `plugins/conversations/plugins/transcript-watcher/server/internal/watcher.ts`

## Verification

1. `./equin build` — compiles, no type errors
2. `./equin check` — all checks pass (plugin-boundaries, eslint, etc.)
3. Open conversation in JSONL viewer — events stream (transcript-watcher still works)
4. Create new conversation — events appear after session ID resolves (the retry path works)
