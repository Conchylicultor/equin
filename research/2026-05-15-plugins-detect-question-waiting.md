# Detect conversations waiting on AskUserQuestion

## Context

The Claude CLI (v2.1.142+) has a bug: when presenting an `AskUserQuestion` interactive prompt, it keeps the spinner glyph (`⠐`) in the tmux pane title and reports `status: "busy"` in `~/.claude/sessions/<pid>.json`. Our status resolver (`resolvePaneStatus`) trusts these signals, so conversations stuck on a question show as "working" instead of "waiting".

The JSONL transcript doesn't help — the CLI only writes `AskUserQuestion` tool calls to the transcript **after** the user answers, so there's no pending tool call to detect.

The only reliable signal is the **tmux pane content** itself: the CLI renders a distinctive interactive prompt (`Enter to select · ↑/↓ to navigate · Esc to cancel`). We can detect this via `tmux capture-pane`.

## Approach

Add a **throttled capture-pane probe** to `tmux-runtime.ts` that runs only for panes currently detected as "busy" (spinner title or session `busy`). If the probe finds a waiting-pattern in the pane content, override `working` to `false` and set `waitingFor`.

### Throttling

- Maintain a `Map<string, { at: number; waiting: boolean }>` keyed by conversation id.
- On each `list()` call, for panes where `resolved.working === true && !dead`:
  - If the cache entry is fresh (< 5 seconds old), reuse the cached `waiting` value.
  - Otherwise, run `tmux capture-pane` and update the cache.
- Evict entries for panes no longer in the pane map.

### Detection patterns

Capture the last 10 lines of the pane (`tmux capture-pane -p -S -10 -t <id>`) and match:

```
Enter to select
```

This is the distinctive footer of the `AskUserQuestion` TUI picker. It's specific enough to avoid false positives from normal assistant text that happens to contain those words (the TUI renders them as part of its chrome, not as streamed content).

### Override

When the probe detects a waiting pattern:
- Set `working: false` on the `RuntimeInfo`
- Set `waitingFor: "question"` so the UI can show what the conversation is waiting for

### File changes

**`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`**

1. Add a `capturePaneProbe(id: string)` async function:
   - Runs `tmux capture-pane -p -S -10 -t <id>` (last 10 lines)
   - Returns `{ waiting: boolean }` based on whether the output matches the detection pattern

2. Add a module-level cache: `const probeCache = new Map<string, { at: number; waiting: boolean }>()`

3. Add a constant: `const PROBE_INTERVAL_MS = 5_000`

4. In `tmuxRuntime.list()`, after the existing `ids.forEach` loop that builds `RuntimeInfo`:
   - Collect all pane ids where `working === true && !dead` 
   - For each, check if the probe cache is stale (> 5s)
   - Run stale probes in parallel via `Promise.all`
   - Apply overrides: if probe says `waiting`, set `working: false` and `waitingFor: "question"`

5. Evict probe cache entries for ids not in the current pane map.

## Verification

1. `./equin build`
2. Find a conversation that's showing a question prompt in tmux but is marked as "working" in the UI
3. Wait up to 5 seconds — the conversation should transition to "waiting"
4. Answer the question in tmux — the conversation should transition back to "working"
5. Check that conversations genuinely working (no question prompt) remain "working"
