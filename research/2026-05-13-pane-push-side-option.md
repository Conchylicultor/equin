# Pane push `side` option — decouple navigation direction from `after`

## Context

The attempt-switch button was broken because `conversationPane` lost its
`after: [null, "attempt"]` declaration during a prior refactor. The deeper
issue: `after` conflates two unrelated concerns:

1. **Structural constraint** — "I need this ancestor's data" (validated by
   `validateChain`, `parseUrl`).
2. **Navigation hint** — drives the "wrap left" logic in `useOpenPane`:
   if `callerPane.after.has(targetId)`, the target is inserted *before*
   the caller instead of after.

`conversationPane` doesn't depend on `attemptPane`'s data — it only
declared `after: ["attempt"]` so the button could insert left. This
change adds an explicit `side: "left" | "right"` option to `push` mode
so `after` can go back to meaning only "I need this ancestor."

## Mental model

The chain is still a flat ordered array `[pane0, pane1, …]` rendered
left-to-right as Miller columns. Nothing changes about the chain shape.

- `after` = "I depend on this ancestor" (structural, validated at chain level)
- `side` on push = "insert before or after me" (navigation intent, caller decides)

## Changes

### 1. `plugins/primitives/plugins/pane/web/pane.ts`

**Types** — Add `side?: "left" | "right"` to the opts object in both
the `useOpenPane` return-type annotation and the inner callback signature.

**Push logic (lines 1005–1029)** — Replace the `callerPane.after.has()`
branch with a `side`-driven branch:

```ts
// push left: insert target immediately before the caller.
if (opts.side === "left") {
  const alreadyAncestor = currentChain
    .slice(0, callerIndex)
    .some((s) => s.paneId === targetInternal.id);
  if (!alreadyAncestor) {
    const newChain = [
      ...currentChain.slice(0, callerIndex),
      createSlot(targetInternal.id, ownParams),
      ...currentChain.slice(callerIndex),
    ];
    setChain(validateChain(newChain), replace);
    return;
  }
}

// push right (default): truncate after caller, append target.
const newChain = [
  ...currentChain.slice(0, callerIndex + 1),
  createSlot(targetInternal.id, ownParams),
];
setChain(validateChain(newChain), replace);
```

**Cleanup** — Remove unused `callerPane` variable (line 984). Keep
`callerPaneId` (still used by swap mode).

### 2. `plugins/attempt-view/web/components/attempt-switch-button.tsx`

Line 32 — add `side: "left"`:

```ts
openPane(attemptPane, { attemptId: conversation.attemptId }, { mode: "push", side: "left" });
```

### 3. `plugins/active-data/plugins/attempt/web/components/attempt-chip.tsx`

Line 37 — add `side: "left"`:

```ts
openPane(attemptPane, { attemptId }, { mode: "push", side: "left" });
```

### 4. `plugins/conversations/plugins/conversation-view/web/panes.tsx`

Remove `after: [null, "attempt"]` — `conversationPane` has no data
dependency on `attemptPane`. Omitting `after` entirely means "valid at
any position" (root or non-root), which matches actual usage.

## Verification

1. `./equin build` — builds and deploys
2. Open a conversation → click the attempt-switch button → attemptPane
   should appear to the LEFT of the conversation
3. Click again → attemptPane should unwrap (disappear)
4. Navigate to `/a/<attemptId>` directly → attemptPane renders as root,
   clicking a conversation opens it to the right
5. In a conversation, verify an inline `att-<id>` chip also opens the
   attempt pane to the left
