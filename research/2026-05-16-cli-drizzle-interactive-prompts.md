# Two-Pass Drizzle-Kit Interactive Prompt Handling

## Context

drizzle-kit v0.28.1 shows interactive prompts when it detects ambiguous schema changes (simultaneous add + delete of the same entity type). Currently `cli/src/migrations.ts` blindly sends 10 `\r` bytes to stdin to auto-accept the first option (create). This is fragile: if there are more prompts than expected, drizzle-kit silently aborts with no migration generated.

The goal is to let agents interact with these prompts directly — seeing the options and making informed decisions (e.g., recognizing a column rename vs a new column).

## Approach: Two-Pass CLI

**Common path (no prompts):** Single pass, zero overhead. drizzle-kit exits cleanly, no structured output.

**Prompt path:**
1. **First pass (detect):** Run drizzle-kit, auto-accept all prompts with `\r` (to advance through them), capture each prompt's question and options as structured data, emit JSON, exit with code 2.
2. Agent reads the structured output, decides answers.
3. **Second pass (answer):** Agent re-runs with `--migration-answers '[{"optionIndex":0},{"optionIndex":1}]'`. CLI sends the correct keystrokes for each prompt.

### Invariant: agents must always explicitly validate prompts

A migration is **never kept** when prompts were present unless the agent provided explicit `--migration-answers`. There is no auto-accept path that silently produces a migration.

### Why detect mode still sends `\r` internally

drizzle-kit shows prompts one at a time — the next only appears after the previous is answered. To discover ALL prompts in a single run, we must advance past each one. In detect mode we send `\r` (selecting option 0) purely to advance and discover subsequent prompts. The generated migration is **always discarded** — detect mode exists only to surface the prompts to the agent.

**Design (chosen):** Unify into a single function that always parses prompts from stdout. Two behaviors based on `--migration-answers`:
- **Without flag (detect mode):** Auto-advance with `\r` for each detected prompt. If any prompts were detected, **discard generated files**, emit structured JSON, exit 2. The agent must re-run with explicit answers.
- **With flag (answer mode):** Use the provided answers to send correct keystrokes. Proceed normally (keep generated files, rename, etc.). This is the only path that produces a migration when prompts exist.

## Implementation

### 1. Structured Output Format

When prompts are detected and no `--migration-answers` was provided, print to stdout:

```
MIGRATION_PROMPTS_DETECTED
[
  {
    "index": 0,
    "entityType": "column",
    "entityName": "user_id",
    "context": "sessions",
    "question": "Is user_id column in sessions table created or renamed from another column?",
    "options": [
      { "index": 0, "action": "create", "label": "+ user_id" },
      { "index": 1, "action": "rename", "label": "~ uid › user_id" }
    ]
  }
]
```

Exit code: 2 (distinguishes from general failure = 1).

### 2. `--migration-answers` Flag

Format: JSON array, positionally matched to prompts in order of appearance. Answers are **semantic** (not positional) because option indices can shift between detect and answer passes when prior renames consume sources.

```json
[
  {"action": "create"},
  {"action": "rename", "from": "uid"}
]
```

- `{"action": "create"}` = select the "create" option (always the first)
- `{"action": "rename", "from": "<source_name>"}` = select the rename option whose source matches `from`

The CLI in answer mode parses each prompt's actual options, finds the one matching the semantic answer, and sends the corresponding number of arrow-downs + Enter. If a `"from"` source doesn't appear in the prompt's options (e.g., already consumed by a prior rename), that's an error.

### 3. Prompt Parsing

drizzle-kit uses `hanji` which writes prompts to stdout with ANSI codes. Key patterns (after ANSI stripping):

**Question line:**
- Column: `Is <name> column in <table> table created or renamed from another column?`
- Other: `Is <name> <type> created or renamed from another <type>?`

**Option lines (immediately follow the question):**
- Create: `❯ + new_name               create column` or `  + new_name               create column`
- Rename: `  ~ old_name › new_name    rename column` or `❯ ~ old_name › new_name    rename column`

**Confirmation (signals prompt was answered):**
- `+ name column will be created`
- `~ old › new column will be renamed`
- `--- all columns conflicts in <table> resolved ---`

### 4. Keystroke Generation

```typescript
function keystrokesForOptionIndex(optionIndex: number): Uint8Array {
  // Arrow-down = ESC [ B = [0x1b, 0x5b, 0x42]
  // Enter = \r = [0x0d]
  const parts: number[] = [];
  for (let i = 0; i < optionIndex; i++) parts.push(0x1b, 0x5b, 0x42);
  parts.push(0x0d);
  return new Uint8Array(parts);
}

function resolveAnswer(
  prompt: DetectedPrompt,
  answer: MigrationAnswer,
): number {
  // Returns the option index to select
  if (answer.action === "create") return 0; // create is always first
  // Find the rename option matching answer.from
  const idx = prompt.options.findIndex(
    (o) => o.action === "rename" && o.fromName === answer.from,
  );
  if (idx === -1) {
    throw new Error(
      `Answer specifies rename from "${answer.from}" but prompt for ` +
      `"${prompt.entityName}" only has options: ${prompt.options.map(o => o.label).join(", ")}`,
    );
  }
  return idx;
}
```
```

### 5. Core Function

Replace the current `Bun.spawn` + blind `\r` block in `generateMigration` with:

```typescript
async function runDrizzleKitWithPrompts(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  answers: MigrationAnswer[] | null, // null = detect mode
): Promise<{
  exitCode: number;
  stdoutBuf: string;
  stderrBuf: string;
  detectedPrompts: DetectedPrompt[];
}>
```

**Logic:**
1. Spawn drizzle-kit with `stdin: "pipe"`, `stdout: "pipe"`, `stderr: "pipe"`, `NO_COLOR=1` in env
2. Stream stdout through an ANSI stripper into a buffer
3. Parse prompts incrementally using a state machine:
   - State: `idle` → waiting for question pattern
   - State: `parsing_options` → collecting option lines after a question
   - State: `awaiting_confirmation` → keystroke sent, waiting for "will be created/renamed"
4. When a complete prompt is detected (question + options):
   - Record it in `detectedPrompts[]`
   - Determine the answer:
     - Detect mode (`answers === null`): always select option 0 (create) to advance
     - Answer mode: call `resolveAnswer(prompt, answers[promptIndex])` to find the matching option index
   - Send keystrokes via `proc.stdin.write(keystrokesForOptionIndex(resolvedIdx))`
   - Transition to `awaiting_confirmation`
5. On confirmation line: transition back to `idle`, increment `promptIndex`
6. On process exit: return all collected data

### 6. Modified `generateMigration` Flow

```
generateMigration(opts):
  ... existing validation, resetBranchLocalMigrations ...
  
  result = await runDrizzleKitWithPrompts(cmd, cwd, env, opts.migrationAnswers ?? null)
  
  if result.exitCode !== 0:
    process.exit(1)
  
  if result.detectedPrompts.length > 0 AND opts.migrationAnswers is null:
    // INVARIANT: never keep a migration that had prompts without explicit answers
    removeGeneratedFiles(migrationsDir, newlyAdded)
    console.log("MIGRATION_PROMPTS_DETECTED")
    console.log(JSON.stringify(result.detectedPrompts, null, 2))
    console.log("\nRe-run with --migration-answers to provide explicit choices.")
    process.exit(2)
  
  ... existing logic: check added files, require --migration-name, rename ...
```

**Key guarantee:** The only code path that keeps generated migration files when prompts were present is when `--migration-answers` was explicitly provided. The agent always sees the prompts first (via exit code 2 + JSON), then explicitly provides answers on the next run.

### 7. Edge Cases

| Case | Handling |
|------|----------|
| More prompts than answers | Error: "Prompt N+1 appeared but only N answers provided. Re-run without --migration-answers to see all prompts." |
| Fewer prompts than answers | Warning only, proceed normally |
| `from` name not found in options | Error: "Answer specifies rename from X but prompt only has [options]. Source may have been consumed by a prior rename." |
| Process dies mid-prompt | Existing non-zero exit code handling catches this |
| No prompts at all | Proceed as today (zero overhead path) |

## Files to Modify

- **`cli/src/migrations.ts`** — Add types (`DetectedPrompt`, `MigrationAnswer`), `stripAnsi()`, `keystrokesForOptionIndex()`, `resolveAnswer()`, `runDrizzleKitWithPrompts()`. Refactor `generateMigration` to use the new runner. Remove the old blind `\r` block and the ad-hoc "silent abort" detection. Export `runDrizzleKitWithPrompts` so the check can reuse it.
- **`cli/src/commands/build.ts`** — Add `--migration-answers <json>` option, parse JSON, pass to `generateMigration`.
- **`tooling/src/checks/migrations-in-sync.ts`** — Replace the direct `Bun.spawn` of drizzle-kit with a call to `runDrizzleKitWithPrompts` (detect mode, no answers). If prompts are detected, fail the check with a message: "Schema has ambiguous changes requiring interactive resolution." This fixes the silent-abort bug where rename prompts cause the check to falsely pass.

## Verification

1. **No-prompt path:** Run `./equin build` on a schema change that doesn't involve renames (add a new table). Should work exactly as before.
2. **Detect mode:** Manually create an ambiguous change (rename a column in schema.ts). Run `./equin build --migration-name test_rename`. Expect exit code 2 + JSON output listing the prompt with all available options.
3. **Answer mode:** Re-run with `--migration-answers '[{"action":"rename","from":"old_col"}]'` to select the rename option. Expect successful migration generation with the rename SQL.
4. **Edge case:** Provide wrong answer count or non-existent `from` name, verify clear error message.
5. **migrations-in-sync check:** With an ambiguous schema change and no committed migration, run `./equin check --migrations-in-sync`. Expect failure with "ambiguous changes requiring interactive resolution" (not a false pass).
