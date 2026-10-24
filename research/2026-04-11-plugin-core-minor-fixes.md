# Plugin-core: pre-index contributions + command handler guard

## Context

Two minor robustness issues in `plugin-core/`:

1. `useContributions()` does a linear `filter` over **all** contributions on every render. Works fine today with ~10 plugins, but scales poorly and is trivially fixable.
2. `defineCommand` silently allows a second `useHandler` call to overwrite an existing handler. This masks bugs — two plugins accidentally handling the same command would be invisible.

## Changes

### 1. Pre-index contributions by `_slotId` in `PluginProvider`

**File:** `plugin-core/context.tsx`

In the `useMemo`, build a `Map<string, P[]>` alongside the flat array:

```ts
const runtime = useMemo(() => {
  const contributions = plugins.flatMap((p) => p.contributions ?? []);
  const bySlot = new Map<string, Contribution[]>();
  for (const c of contributions) {
    let list = bySlot.get(c._slotId);
    if (!list) {
      list = [];
      bySlot.set(c._slotId, list);
    }
    bySlot.set(c._slotId, list);
    list.push(c);
  }
  return { plugins, contributions, bySlot };
}, [plugins]);
```

Add `bySlot` to the `PluginRuntime` interface.

**File:** `plugin-core/slots.ts`

Change `useContributions` to read from the index:

```ts
slot.useContributions = () => {
  const ctx = useContext(PluginRuntimeContext);
  if (!ctx) throw new Error("useContributions must be used within PluginProvider");
  return (ctx.bySlot.get(id) ?? []).map(({ _slotId: _, ...rest }) => rest as P);
};
```

### 2. Dev-mode assertion in `defineCommand`

**File:** `plugin-core/commands.ts`

In `useHandler`, before setting `handler`, assert it isn't already set:

```ts
useEffect(() => {
  if (process.env.NODE_ENV !== "production" && handler !== null) {
    console.error(`Command "${id}" already has a handler. Two components called useHandler for the same command — this is a bug.`);
  }
  handler = (args) => ref.current(args);
  return () => { handler = null; };
}, []);
```

Use `console.error` rather than `throw` — throwing inside `useEffect` would crash the app. The error message identifies the command by name, making the conflict easy to find.

## Files modified

- `plugin-core/context.tsx` — add `bySlot` map to runtime
- `plugin-core/slots.ts` — use `bySlot` instead of `filter`
- `plugin-core/commands.ts` — add handler-already-set warning

## Verification

1. `bun build` from `web/` — type-check passes
2. `./equin build` — app loads, all sidebar items / toolbar buttons / status bar render as before
3. To test the command guard: temporarily mount a second component calling `Shell.OpenPane.useHandler(...)` and confirm the console error appears
