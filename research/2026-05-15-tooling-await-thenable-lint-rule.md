# Add `@typescript-eslint/await-thenable` lint rule

## Context

`Bun.FileSink.write()` returns a `number`, not a `Promise`. Code using `await proc.stdin.write(text)` compiles fine and appears correct, but the `await` is a no-op — `await 5` resolves immediately without waiting for anything. This caused a production crash in `push-and-exit` where pipe data was lost before `end()` flushed it, and `tmux load-buffer` received empty stdin.

The `@typescript-eslint/await-thenable` rule flags `await` on non-Promise expressions, catching this class of bug at lint time.

## Changes

### 1. Enable the rule — `eslint.config.ts`

Add to the `rules` object at line ~121:

```ts
"@typescript-eslint/await-thenable": "error",
```

No new packages, parser changes, or tsconfig changes needed — type-aware linting via `projectService` is already active, and `@typescript-eslint/eslint-plugin` is already registered.

### 2. Fix existing violation — `plugins/infra/plugins/claude-cli/server/internal/run-claude-print.ts:72-73`

Same pattern as the tmux bug. Replace:

```ts
stdin: "pipe",
...
await proc.stdin.write(input.prompt);
await proc.stdin.end();
```

With:

```ts
stdin: Buffer.from(input.prompt),
```

The tmux-runtime.ts instance was already fixed earlier in this session.

### 3. Run eslint to catch any other violations

`./equin check --eslint` — fix anything it finds.

## Verification

1. `./equin check --eslint` passes
2. `./equin build` succeeds
