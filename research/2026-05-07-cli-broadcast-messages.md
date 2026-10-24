# CLI Broadcast Messages

## Context

After breaking changes on `main` (e.g. DB infra refactor), agents in old worktrees hit cryptic failures. There's no way to tell them "this is expected — rebase to main." This adds a broadcast system: messages stored on `main` that the CLI reads and displays when a worktree is behind the relevant commits.

## Design

### Broadcast file: `cli/broadcasts.json`

Stored on `main`. The CLI reads it from `origin/main` HEAD (not the worktree's stale copy).

```json
[
  {
    "since": "abc1234",
    "until": "def5678",
    "severity": "error",
    "message": "DB infra moved to plugins/database/. Rebase to main before building."
  }
]
```

| Field | Required | Default | Meaning |
|-------|----------|---------|---------|
| `since` | no | -∞ | Show if worktree merge-base is before this commit |
| `until` | no | +∞ | Stop showing once merge-base reaches this commit |
| `severity` | yes | — | `"error"` blocks command; `"warning"` / `"info"` just print |
| `message` | yes | — | Human-readable text |

Both fields omitted → always display for all worktrees.

### How matching works

1. Get the worktree's merge-base with `origin/main`: `git merge-base HEAD origin/main`
2. For each broadcast entry, check:
   - `since` set → `git merge-base --is-ancestor <merge-base> <since>` (merge-base is before the breaking change)
   - `until` set → `git merge-base --is-ancestor <merge-base> <until>` (merge-base hasn't passed the expiry)
   - Omitted field → always matches
3. Entry applies when both conditions are true

## Implementation

### New file: `cli/src/broadcasts.ts`

Single export: `checkBroadcasts(): Promise<void>`

```typescript
interface Broadcast {
  since?: string;
  until?: string;
  severity: "error" | "warning" | "info";
  message: string;
}

async function gitOutput(args: string[]): Promise<string | null> {
  // Bun.spawn(["git", ...args]), return trimmed stdout or null on failure
}

async function isAncestor(ancestor: string, descendant: string): Promise<boolean> {
  // git merge-base --is-ancestor <ancestor> <descendant>
  // exit 0 = true, anything else = false
}

export async function checkBroadcasts(): Promise<void> {
  // 1. Get branch — skip if "main"
  // 2. git show origin/main:cli/broadcasts.json — silent skip on failure
  // 3. Parse JSON — silent skip on failure
  // 4. git merge-base HEAD origin/main — silent skip on failure
  // 5. Filter matching entries via isAncestor checks
  // 6. Print banners
  // 7. process.exit(1) if any severity === "error"
}
```

All git failures are silent (return early, don't break the CLI).

### New file: `cli/broadcasts.json`

```json
[]
```

Empty initial file. Committed to `main` so `git show` resolves it.

### Integration (one line each)

**`cli/src/commands/build.ts`** — line 418, after the `branch === "main"` guard:
```typescript
import { checkBroadcasts } from "../broadcasts";
// ...
await checkBroadcasts();  // after line 417 (end of main-branch guard)
```

**`cli/src/commands/push.ts`** — line 199, after `const onMain = branch === "main"`:
```typescript
import { checkBroadcasts } from "../broadcasts";
// ...
await checkBroadcasts();  // after line 198
```

**`cli/src/commands/check.ts`** — top of `.action()`, before `runChecks()`:
```typescript
import { checkBroadcasts } from "../broadcasts";
// ...
await checkBroadcasts();  // first thing in .action(), after opts.list early return
```

### Output format

```
════════════════════════════════════════════════════════════════════════════════
⚠ BROADCAST [ERROR]: DB infra moved to plugins/database/. Rebase to main.
════════════════════════════════════════════════════════════════════════════════
```

- `error` → `console.error`, blocks with `process.exit(1)` after all banners print
- `warning` → `console.warn`, continues
- `info` → `console.log`, continues

### Edge cases (all handled silently)

- On `main` → skip (broadcasts are for worktrees)
- `origin/main` not fetched → `git show` fails → skip
- `broadcasts.json` not on main yet → `git show` fails → skip
- Malformed JSON → parse error caught → skip
- Unknown SHA in `since`/`until` → `isAncestor` returns false → message doesn't fire
- Not in a git repo → skip

## Verification

1. Create a test broadcast entry in `cli/broadcasts.json` with no `since`/`until` (always matches)
2. Run `./equin check` from a worktree — should see the banner
3. Set `severity: "error"` — should block the command
4. Add `since` pointing to a future commit — should not match (worktree is already past it)
5. Remove the test entry, commit the empty `[]`
