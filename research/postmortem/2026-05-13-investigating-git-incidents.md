# Investigating Git Incidents on Main

This is a write-up from debugging a real incident: main's working tree ended up
with unresolved conflict markers, blocking pushes. Here's what I learned.

## What actually happened

An agent running `att-1778540417-oz3y` wanted to verify whether a lint check
already failed on main before its changes. It did this:

```bash
cd /Users/epot/__A__/dev/singularity && git stash && ./equin check ; git stash pop
```

The intent was "stash, check clean main, restore." But main was already clean,
so `git stash` was a no-op. Then `git stash pop` popped `stash@{0}` — a
10-day-old stash left by a different agent — which conflicted with commits that
had landed since. Main's working tree ended up with conflict markers.

The agent then tried to push, saw the broken main worktree, concluded it was
"another agent's conflict", flagged it, and exited. It didn't realize it had
caused the problem 2 minutes earlier.

---

## Reading the initial git status

When `git status` on main shows `Unmerged paths` but `Your branch is up to date
with 'origin/main'`, the committed history is clean. The damage is only in the
working tree / index. This distinction matters: it means no bad code was pushed,
and the fix is cheap.

`git show HEAD:<conflicted-file> | grep '<<<<'` confirms whether conflict
markers are in the commit or just the working tree. Zero hits = committed state
is fine.

Checking for in-progress operations:

```bash
ls .git/MERGE_HEAD .git/rebase-merge .git/CHERRY_PICK_HEAD 2>&1
```

If none of those exist but `git status` still shows unmerged paths, the conflict
was left behind by a `git stash pop` (or `git stash apply`) that failed — the
MERGE_HEAD gets cleaned up automatically on stash conflicts, but the index
entries stay dirty.

## Reading conflict marker labels

The exact labels in `<<<<<<< / >>>>>>>` narrow down the git operation:

| Labels | Operation |
|---|---|
| `HEAD` / `branch-name` | `git merge` |
| `HEAD` / `commit-sha` | `git rebase` or `git cherry-pick` |
| `Updated upstream` / `Stashed changes` | `git stash pop` or `git stash apply` |

"Updated upstream" / "Stashed changes" is unique to stash. Seeing those labels
immediately ruled out every push-related flow (push.ts uses `--ff-only` merges
and rebases, neither of which produces those labels).

## Locating when it happened

File mtime gives you the timestamp of the stash pop:

```bash
stat -f "%m %N" <conflicted-file>
# convert epoch to UTC:
python3 -c "import datetime; print(datetime.datetime.fromtimestamp(1778544521, tz=datetime.timezone.utc))"
```

Cross-reference with `git reflog --date=iso` on main to see which pushes
happened before and after. The conflict mtime fell in a 7-minute gap between
two known agent sessions, which made the window small enough to search.

`git reflog` only records HEAD changes, so stash pops don't show up there. But
comparing the mtime to push timestamps pinpoints the window.

## Searching JSONL sessions

Every agent's tool calls are in
`~/.claude/projects/<project-path>/sessions/<uuid>.jsonl`.

### Finding files modified in a time window

```bash
rg --files -g "*.jsonl" ~/.claude/projects/ | while read f; do
  mtime=$(stat -f "%m" "$f")
  if [ "$mtime" -ge $START_EPOCH ] && [ "$mtime" -le $END_EPOCH ]; then
    echo "$mtime $f"
  fi
done | sort
```

This found the exact session file that was being written during the conflict
window. Be careful: the JSONL file mtime reflects the last event written to it,
not when the session started.

### Extracting commands from JSONL

`rg 'stash pop' <file>` returns false positives — it matches text mentions in
assistant messages and tool result outputs, not just actual commands. Parse
properly:

```python
import json
with open(f) as fh:
    for line in fh:
        ev = json.loads(line)
        for c in ev.get('message', {}).get('content', []):
            if c.get('type') == 'tool_use' and c.get('name') == 'Bash':
                cmd = c['input'].get('command', '')
                if 'stash' in cmd:
                    print(ev['timestamp'], cmd)
```

The `cwd` field on each event shows where the agent was running — an important
detail when the agent used `cd` to jump to a different directory mid-session.

### Cross-referencing with the DB

```sql
SELECT id, title, attempt_id, created_at FROM conversations
WHERE attempt_id = 'att-1778540417-oz3y'
```

Links a JSONL session UUID back to the task title, which gives you the "what was
this agent trying to do" context.

## The stash reflog

```bash
git reflog refs/stash
```

Shows stash creation events. Crucially: `git stash pop` with conflicts does NOT
drop the stash entry (the drop only happens on success). So if `stash@{0}` still
exists after a pop was run, the pop conflicted. One entry = stash was created
once and never successfully consumed.

## What went wrong (the actual bug)

The agent violated two rules:

1. **It `cd`'d into the main worktree** and ran git commands there. Agents must
   only operate on their own worktree directory. The main worktree is shared
   infrastructure — touching it with raw git commands is inherently unsafe.

2. **`git stash && ... && git stash pop` is not a safe "clean check" pattern**
   when there's an existing stash. It should have been `git -C
   /path/to/worktree status` (read-only) or run the check directly from the
   worktree without touching main's index at all.

The deeper issue: the stash from 10 days earlier was itself a code smell — it
represented unfinished work never cleaned up after a worktree was abandoned.
Worktrees should be self-contained; if a worktree agent stashes work, that stash
is a liability for anyone else who runs git in the same repo.

## Fixing the broken main working tree

The committed state was fine throughout. The fix is:

```bash
# Drop the conflict state from the index
git checkout -- plugins/agents/web/index.ts \
                plugins/tasks/plugins/task-list/web/slots.ts \
                plugins/tasks/web/index.ts
# Unstage the auto-regenerated CLAUDE.md changes
git reset HEAD plugins/agents/CLAUDE.md plugins/tasks/CLAUDE.md \
               plugins/tasks/plugins/task-list/CLAUDE.md \
               plugins/tasks/plugins/task-list/web/components/tasks-list.tsx
```

The stash (`stash@{0}`) is still there and should eventually be dropped with
`git stash drop` once the `AgentTaskIcon` work it contains is either landed or
abandoned.
