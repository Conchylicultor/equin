# Server-side Contributions Primitive

## Context

The web plugin system has a clean declarative contribution model: plugins define slots (`defineSlot`), other plugins contribute to them (`contributions: [MySlot({...})]`), and the framework collects and indexes everything in `PluginProvider`. The server has no equivalent — plugins do all cross-plugin wiring imperatively in `onReady` (e.g. 11 trigger registrations across 8 plugins, all identical `deleteTriggersFor + trigger` boilerplate).

This plan adds a generic server-side contribution primitive that mirrors the web pattern. The first consumer will be triggers (handled by a separate child agent), but the API is designed for any plugin to define contribution types.

## Design

### Core API

```typescript
// server/src/contributions.ts

/** Opaque contribution — framework sees only the kind tag. */
export type ServerContribution = { readonly _kind: symbol; [key: string]: unknown };

/** Token returned by defineServerContribution — both factory and query handle. */
export interface ServerContributionToken<P> {
  (props: P): ServerContribution;
  getContributions(): P[];
}

/** Define a new contribution type. Returns a factory+query token. */
export function defineServerContribution<P>(
  debugName: string,
): ServerContributionToken<P>;
```

Mirrors web's `defineSlot<P>(id)` → `Slot<P>`:
- Web: `const MySlot = defineSlot<P>(id)` → `MySlot(props)` to contribute, `MySlot.useContributions()` to consume
- Server: `const MyContrib = defineServerContribution<P>(name)` → `MyContrib(props)` to contribute, `MyContrib.getContributions()` to consume

Key differences from web:
- Uses `symbol` keys instead of string IDs (no collision risk, no string registry)
- `getContributions()` reads from module-level state instead of React context
- The `debugName` is for logging/inspection only, not lookup

### Implementation

```typescript
// server/src/contributions.ts

export type ServerContribution = {
  readonly _kind: symbol;
  _pluginId?: string;
  _pluginName?: string;
  [key: string]: unknown;
};

export interface ServerContributionToken<P> {
  (props: P): ServerContribution;
  getContributions(): (P & { _pluginId?: string; _pluginName?: string })[];
}

// Module-level store, populated by collectContributions() at boot
let byKind: Map<symbol, ServerContribution[]> = new Map();

export function defineServerContribution<P>(
  debugName: string,
): ServerContributionToken<P> {
  const kind = Symbol(debugName);

  const token = ((props: P) => ({
    _kind: kind,
    ...props,
  })) as unknown as ServerContributionToken<P>;

  token.getContributions = () => {
    return (byKind.get(kind) ?? []).map(
      ({ _kind: _, ...rest }) => rest as P & { _pluginId?: string; _pluginName?: string },
    );
  };

  return token;
}

/**
 * Called once by the bootstrap between register and onReady phases.
 * Collects all contributions from all plugins, injects plugin metadata,
 * and indexes by kind symbol.
 */
export function collectContributions(
  plugins: { id: string; name: string; contributions?: ServerContribution[] }[],
): void {
  byKind = new Map();
  for (const p of plugins) {
    for (const c of p.contributions ?? []) {
      c._pluginId = p.id;
      c._pluginName = p.name;
      let list = byKind.get(c._kind);
      if (!list) {
        list = [];
        byKind.set(c._kind, list);
      }
      list.push(c);
    }
  }
}
```

### Bootstrap integration

In `server/src/index.ts`, add one call between register and route population:

```
Phase 1 — register (existing)
↓
NEW: collectContributions(ordered)     ← flat-maps contributions, indexes by kind
↓
Route table population (existing)
↓
Socket bind (existing)
↓
Phase 2 — onReady (existing)           ← consuming plugins call Token.getContributions() here
```

### Consumer example (trigger migration — separate agent)

```typescript
// events plugin barrel — defines the token
export const Trigger = defineServerContribution<TriggerSpec>("trigger");

// consumer plugin — contributes
export default {
  register: [classifyConversationJob],
  contributions: [
    Trigger({
      on: conversationTurnCompleted,
      do: classifyConversationJob,
      with: {},
      oneShot: false,
    }),
  ],
} satisfies ServerPluginDefinition;

// events plugin onReady — consumes
onReady: async () => {
  for (const t of Trigger.getContributions()) {
    await deleteTriggersFor(t.do);
    await trigger(t);
  }
},
```

## What should become contributions

### Now — triggers (first target, separate agent)

11 permanent trigger registrations across 8 plugins. All identical boilerplate. Pure declarative data.

### Future — `config` and `resources`

Both `config` and `resources` are top-level fields on `ServerPluginDefinition` that core never processes — they're data annotations consumed exclusively by their owning plugins:

**`config`**: The bootstrap ignores it entirely. The config plugin imports the full plugin list from `@server/plugins` and walks `p.config` in its own `onReady` via `buildRegistry(allPlugins)`. It uses a `WeakMap<ConfigDescriptor, string>` to map descriptor object identity → plugin ID, which is how `readConfig(descriptor)` later knows which plugin's namespace to query. The `ConfigDescriptorLike` type on `ServerPluginDefinition` is a plugin-specific concern leaked into core.

**`resources`**: Declared on the definition but never iterated by the bootstrap. `defineResource` populates a module-level registry as a side effect of evaluation. The field exists for documentation/codegen only.

Both could become contributions:

```typescript
// config plugin defines
export const Config = defineServerContribution<ConfigDescriptor>("config");

// consumer plugin
contributions: [Config(buildConfig)]

// config plugin onReady — uses _pluginId injected by the framework
for (const c of Config.getContributions()) {
  registerConfig(c._pluginId, c);  // no more WeakMap trick
}
```

This would:
- Remove `ConfigDescriptorLike` and `ResourceLike` from `server/src/types.ts`
- Eliminate the WeakMap hack in config (the framework injects `_pluginId` automatically)
- Make the dependency direction clean: core knows nothing about config or resources

Not in this PR — the current mechanism works. But this validates that contributions aren't just for triggers.

### Stay as-is

| Current pattern | Verdict | Reason |
|---|---|---|
| `httpRoutes` / `wsRoutes` | Stay as top-level fields | Consumed by the framework bootstrap itself (route table population). Core genuinely owns these. |
| `register` items (`Mcp.tool`, `defineJob`, `defineTriggerEvent`) | Stay in `register` | Dual-purpose objects — their public API (`.enqueue()`, `.emit()`) must be typed named exports, incompatible with opaque contribution data |
| `ensureXxxMetaTask()` (4-5 plugins) | Stay in `onReady` | Async DB operations; too few instances to justify a contribution type; transparency of seeing the call inline is valuable |
| Background services (`startWorker`, `startGitWatcher`, etc.) | Stay in `onReady`/`onShutdown` | Genuinely imperative lifecycle work |

## Files to modify

### Create

- **`server/src/contributions.ts`** — `defineServerContribution`, `ServerContribution`, `ServerContributionToken`, `collectContributions`

### Modify

- **`server/src/types.ts`** — Add `contributions?: ServerContribution[]` to `ServerPluginDefinition`. Import `ServerContribution` from `./contributions`.
- **`server/src/index.ts`** — Add `collectContributions(ordered)` call between register phase (line 26) and route table population (line 28). Import from `./contributions`.

### Central (later, if needed)

Central has only 4 plugins and no contribution use case today. Add the same primitive when a need arises — the code is small (~40 lines). No changes to central in this PR.

## Verification

1. `./equin build` — confirms the server compiles and starts
2. Existing behavior unchanged — no consumers use contributions yet (trigger migration is separate)
3. Check that `collectContributions` runs at the right phase by adding a temporary log and confirming it appears between register and onReady spans in the profiler output
