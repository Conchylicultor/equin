# Inter-Plugin Communication — Design Options

## Context

equin's plugin system has one primitive: **slots** (static, declarative contributions collected at registration time). There is no mechanism for runtime imperative actions between plugins.

**First concrete use case:** a task list plugin tells the terminal plugin "open a Claude Code terminal at `/path/to/worktree`."

**Second use case (dynamic shell panels):** any plugin says "create a panel with this component" and gets back a panel ID. This is a prerequisite dependency — the option chosen here shapes the dynamic panels design.

Both are imperative, runtime, request-response actions. Slots don't cover this.

## Constraints

- plugin-core is ~60 lines. Additions should be proportionally small.
- Plugins import lightweight definition files (`slots.ts`), never internal components. Same boundary applies here.
- React context model. No global singletons without justification.
- Statically imported plugins.

---

## Option 1: Command Registry

A `defineCommand<Args, Return>(id)` primitive. Provider registers a handler, consumer gets a typed dispatch function. Handlers stored in a mutable `Map` on a ref (no re-renders).

### plugin-core addition (~30 lines)

```typescript
// plugin-core/commands.ts
export interface Command<Args, Return> {
  id: string;
  useHandler(handler: (args: Args) => Return): void;
  useDispatch(): (args: Args) => Return;
}

export function defineCommand<Args, Return = void>(id: string): Command<Args, Return> {
  return {
    id,
    useHandler(handler) {
      const ctx = useContext(PluginRuntimeContext);
      const ref = useRef(handler);
      ref.current = handler;
      useEffect(() => {
        ctx!.commands.set(id, (args: unknown) => ref.current(args as Args));
        return () => { ctx!.commands.delete(id); };
      }, [ctx]);
    },
    useDispatch() {
      const ctx = useContext(PluginRuntimeContext);
      return useCallback((args: Args) => {
        const handler = ctx!.commands.get(id);
        if (!handler) throw new Error(`No handler for command "${id}"`);
        return handler(args) as Return;
      }, [ctx]);
    },
  };
}
```

`context.tsx` gains: `commands: Map<string, Function>` (initialized via `useRef`).

### Terminal plugin (provider)

```typescript
// plugins/terminal/web/commands.ts
export const Terminal = {
  Open: defineCommand<{ worktree: string }, string>("terminal.open"),
};
```

```typescript
// Inside a mounted component
Terminal.Open.useHandler(({ worktree }) => {
  return createTerminalSession(worktree); // returns sessionId
});
```

### Task list plugin (consumer)

```typescript
import { Terminal } from "@plugins/terminal/web/commands";

function TaskRow({ task }: { task: Task }) {
  const openTerminal = Terminal.Open.useDispatch();
  return <button onClick={() => openTerminal({ worktree: task.worktreePath })}>Launch</button>;
}
```

### Dynamic panels use case

```typescript
const ShellCommands = {
  CreatePanel: defineCommand<{ title: string; component: ComponentType }, string>("shell.panel.create"),
  FocusPanel: defineCommand<{ panelId: string }, void>("shell.panel.focus"),
};
```

### Tradeoffs

| | |
|---|---|
| **+** Return values | Synchronous, typed |
| **+** Mirrors slots | `defineCommand` parallels `defineSlot`, `commands.ts` parallels `slots.ts` |
| **+** No re-renders | Ref-based storage |
| **+** Minimal | ~30 lines in plugin-core |
| **−** Throws if no handler | Provider must mount before consumer dispatches |
| **−** Single handler | 1:1 only, no broadcast |
| **−** Needs mounted component | Provider must render (even if `return null`) to call `useHandler` |

---

## Option 2: Event Bus

Typed pub/sub. Plugins emit named events and subscribe. Fire-and-forget — no return values.

### plugin-core addition (~30 lines)

```typescript
// plugin-core/events.ts
export interface PluginEvent<Payload> {
  id: string;
  useEmit(): (payload: Payload) => void;
  useListen(handler: (payload: Payload) => void): void;
}

export function defineEvent<Payload>(id: string): PluginEvent<Payload> {
  return {
    id,
    useEmit() {
      const ctx = useContext(PluginRuntimeContext);
      return (payload: Payload) => {
        ctx!.eventListeners.get(id)?.forEach((fn) => fn(payload));
      };
    },
    useListen(handler) {
      const ctx = useContext(PluginRuntimeContext);
      const ref = useRef(handler);
      ref.current = handler;
      useEffect(() => {
        const wrapper = (p: unknown) => ref.current(p as Payload);
        const set = ctx!.eventListeners.get(id) ?? new Set();
        set.add(wrapper);
        ctx!.eventListeners.set(id, set);
        return () => { set.delete(wrapper); };
      }, [ctx]);
    },
  };
}
```

`context.tsx` gains: `eventListeners: Map<string, Set<Function>>`.

### Terminal plugin (provider/listener)

```typescript
// plugins/terminal/web/events.ts
export const TerminalEvents = {
  OpenRequested: defineEvent<{ worktree: string }>("terminal.open-requested"),
  Opened: defineEvent<{ sessionId: string; worktree: string }>("terminal.opened"),
};
```

```typescript
// Provider listens and emits a response event
const emitOpened = TerminalEvents.Opened.useEmit();
TerminalEvents.OpenRequested.useListen(({ worktree }) => {
  const sessionId = createTerminalSession(worktree);
  emitOpened({ sessionId, worktree });
});
```

### Task list plugin (consumer/emitter)

```typescript
import { TerminalEvents } from "@plugins/terminal/web/events";

function TaskRow({ task }: { task: Task }) {
  const requestOpen = TerminalEvents.OpenRequested.useEmit();
  return <button onClick={() => requestOpen({ worktree: task.worktreePath })}>Launch</button>;
}
```

Getting the `sessionId` back requires subscribing to `TerminalEvents.Opened` and correlating by worktree or a request ID — significantly more complex.

### Dynamic panels use case

```typescript
const ShellEvents = {
  PanelRequested: defineEvent<{ title: string; component: ComponentType }>("shell.panel.requested"),
  PanelCreated: defineEvent<{ panelId: string }>("shell.panel.created"),
};
// Consumer must correlate PanelRequested → PanelCreated to get the panelId back
```

### Tradeoffs

| | |
|---|---|
| **+** Multiple listeners | 1:N broadcast |
| **+** Graceful on missing listener | Silent no-op, no throw |
| **+** Familiar | DOM events, EventEmitter |
| **−** No return values | Request-response requires a second event + correlation IDs |
| **−** Weaker type safety | No compile-time guarantee a listener exists |
| **−** Awkward for the terminal use case | The primary use case is request-response |
| **−** Harder to debug | "Who emitted this? Who handled it?" |

---

## Option 3: Shared Reactive State

Shared stores where plugins read/write named state slices. Module-level singletons (like zustand).

### plugin-core addition (~25 lines)

```typescript
// plugin-core/state.ts
export interface SharedState<T> {
  id: string;
  useValue(): T;
  useSet(): (updater: T | ((prev: T) => T)) => void;
}

export function defineState<T>(id: string, initialValue: T): SharedState<T> {
  let value = initialValue;
  const listeners = new Set<() => void>();

  return {
    id,
    useValue() {
      return useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        () => value,
      );
    },
    useSet() {
      return useCallback((updater: T | ((prev: T) => T)) => {
        value = typeof updater === "function" ? (updater as Function)(value) : updater;
        listeners.forEach((cb) => cb());
      }, []);
    },
  };
}
```

No changes to `context.tsx` — state is module-level.

### Terminal plugin (provider)

```typescript
// plugins/terminal/web/state.ts
export const TerminalState = {
  requests: defineState<{ id: string; worktree: string }[]>("terminal.requests", []),
  sessions: defineState<{ id: string; worktree: string }[]>("terminal.sessions", []),
};
```

```typescript
// Provider watches requests, processes them, clears them
const requests = TerminalState.requests.useValue();
const setRequests = TerminalState.requests.useSet();
const setSessions = TerminalState.sessions.useSet();

useEffect(() => {
  for (const req of requests) {
    if (processedRef.current.has(req.id)) continue;
    processedRef.current.add(req.id);
    const session = createTerminalSession(req.worktree);
    setSessions((prev) => [...prev, { id: session.id, worktree: req.worktree }]);
  }
  if (requests.length > 0) setRequests([]);
}, [requests]);
```

### Task list plugin (consumer)

```typescript
import { TerminalState } from "@plugins/terminal/web/state";

function TaskRow({ task }: { task: Task }) {
  const setRequests = TerminalState.requests.useSet();
  return (
    <button onClick={() => setRequests((prev) => [...prev, { id: crypto.randomUUID(), worktree: task.worktreePath }])}>
      Launch
    </button>
  );
}
```

### Dynamic panels use case

```typescript
const ShellState = {
  panels: defineState<Panel[]>("shell.panels", []),
};
// Reactive: shell re-renders when panels change. Natural for UI state.
// But "create a panel" is modeled as a state mutation, not an action.
```

### Tradeoffs

| | |
|---|---|
| **+** Fully reactive | Components re-render on change |
| **+** Inspectable | State is always readable |
| **+** Familiar React pattern | zustand/jotai style |
| **−** Actions as state mutations | "Open terminal" = "append to queue" — provider must implement queue processing, dedup, cleanup |
| **−** Re-renders on every change | All subscribers re-render |
| **−** Module-level singletons | Breaks React context model; complicates testing |
| **−** No return values | Same correlation problem as events |
| **−** Data model coupling | Consumer must know the request shape |

---

## Option 4: Service Locator

Plugins register service objects with typed methods. Others look them up and call methods directly.

### plugin-core addition (~40 lines)

```typescript
// plugin-core/services.ts
export interface ServiceDefinition<T> {
  id: string;
  useRegister(service: T): void;
  useService(): T;
}

export function defineService<T>(id: string): ServiceDefinition<T> {
  return {
    id,
    useRegister(service: T) {
      const ctx = useContext(PluginRuntimeContext);
      const ref = useRef(service);
      ref.current = service;
      useEffect(() => {
        const proxy = new Proxy({} as T, {
          get(_, prop) { return (ref.current as any)[prop]; },
        });
        ctx!.services.set(id, proxy);
        return () => { ctx!.services.delete(id); };
      }, [ctx]);
    },
    useService() {
      const ctx = useContext(PluginRuntimeContext);
      const service = ctx!.services.get(id);
      if (!service) throw new Error(`Service "${id}" not registered`);
      return service as T;
    },
  };
}
```

`context.tsx` gains: `services: Map<string, unknown>`.

### Terminal plugin (provider)

```typescript
// plugins/terminal/web/services.ts
export interface TerminalService {
  open(worktree: string): string;
  close(sessionId: string): void;
  list(): string[];
}

export const Terminal = {
  Service: defineService<TerminalService>("terminal.service"),
};
```

```typescript
Terminal.Service.useRegister({
  open(worktree) { return createTerminalSession(worktree).id; },
  close(sessionId) { destroySession(sessionId); },
  list() { return getActiveSessionIds(); },
});
```

### Task list plugin (consumer)

```typescript
import { Terminal } from "@plugins/terminal/web/services";

function TaskRow({ task }: { task: Task }) {
  const terminal = Terminal.Service.useService();
  return <button onClick={() => terminal.open(task.worktreePath)}>Launch</button>;
}
```

### Dynamic panels use case

```typescript
export interface PanelManager {
  create(title: string, component: ComponentType): string;
  focus(panelId: string): void;
  close(panelId: string): void;
}
const ShellServices = { Panels: defineService<PanelManager>("shell.panels") };
```

### Tradeoffs

| | |
|---|---|
| **+** Rich interface | Multiple methods per service (open, close, list, focus) |
| **+** Return values | Natural method returns |
| **+** Familiar OOP | Easy to understand |
| **−** Larger API surface | Interface becomes a contract, harder to evolve |
| **−** Proxy indirection | Runtime magic, surprising |
| **−** Same ordering dependency | Throws if provider not mounted |
| **−** Encourages fat interfaces | Blurs "lightweight definition" vs "importing internals" |
| **−** Heaviest primitive | ~40 lines, more conceptual weight |

---

## Comparison Matrix

| | Commands | Events | Shared State | Services |
|---|---|---|---|---|
| Return values | Yes | No | No | Yes |
| Type safety | Full (Args + Return) | Payload only | Value only | Full (interface) |
| Multiple handlers | No (1:1) | Yes (1:N) | N/A | No (1:1) |
| Missing handler | Throws | Silent no-op | N/A | Throws |
| Re-renders | None | None | Yes | None |
| Lines in plugin-core | ~30 | ~30 | ~25 | ~40 |
| Conceptual weight | Low | Medium | Medium | Medium-high |
| "Open terminal" | Natural | Awkward | Unnatural | Natural |
| "Create panel" | Natural | Awkward | Workable | Natural |
| Broadcast | No | Yes | Workable | No |

## Hybrid Notes

These are not mutually exclusive:
- **Commands + Events**: Commands for request-response, events for broadcast. Two primitives, each in its natural lane.
- **Commands only, events later**: Start with commands. Add events if a broadcast use case actually arises. YAGNI-friendly.
- **Services subsume commands**: A single-method service is a command. But this encourages larger interfaces earlier than needed.

---

## Files That Would Change

Regardless of option chosen:

| File | Change |
|---|---|
| `plugin-core/{commands,events,state,services}.ts` | New file — the primitive implementation |
| `plugin-core/context.tsx` | Add storage to `PluginRuntime` (except Option 3 which uses module singletons) |
| `plugin-core/index.ts` | Export new primitive |
| `plugin-core/CLAUDE.md` | Document the new primitive |
