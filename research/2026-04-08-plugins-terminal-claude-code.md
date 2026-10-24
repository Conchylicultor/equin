# Terminal Plugin — Claude Code Instances

## Context

equin needs a terminal plugin to launch and manage Claude Code agent instances. Each agent runs in its own git worktree, so the terminal must be spawnable with a configurable working directory. Multiple instances run in parallel.

This design is **blocked on two prerequisite architectural decisions** that affect the entire plugin system, not just the terminal. Those must be designed separately before the terminal plugin can be fully specified.

## What We Know

### Scope
- **Claude Code only** — this plugin launches `claude` CLI, not a general shell
- **Modular internals** — the xterm/pty/WebSocket plumbing should be reusable so a future generic terminal plugin (or other CLI-based plugins) can share it
- **Session persistence** — v0 is ephemeral (terminals die on unmount). Target: server-side buffering so conversations survive page refresh. Separate design.

### Backend (ready to build)
The xterm.js + node-pty + WebSocket architecture from the [terminal plugin research](2026-04-08-terminal-plugin.md) is solid. One addition for Claude Code:

- `session.create` gains `cwd: string` (worktree path) and hardcodes `command: "claude"` with appropriate flags
- PTY manager spawns in the specified `cwd`
- One WebSocket connection per terminal instance at `/ws/terminal`

### Frontend (blocked)
Two open questions block the frontend design:

## Prerequisite 1: Inter-Plugin Communication

**Problem:** A task list plugin needs to say "open a Claude Code terminal at `/path/to/worktree`." Today, plugins can only communicate via static slot contributions — there's no mechanism for runtime actions between plugins.

**Needs its own design doc** exploring options, tradeoffs, and what plugin code looks like in each:

| Option | Mechanism | Tradeoffs |
|--------|-----------|-----------|
| Command registry | `defineCommand<A,R>(id)` in plugin-core — typed named commands, plugins register handlers, others dispatch | Discoverable, typed, return values. Adds a new primitive. |
| Event bus | Pub/sub — `emit("terminal.open", { worktree })` | Loose coupling, fire-and-forget. No return values, no type safety without extra work. |
| Shared state | Zustand/jotai store watched by terminal, written by others | Reactive, familiar React pattern. Couples plugins at data model level. |
| Service locator | Plugins register service objects, others look them up by ID | OOP-style, flexible. Requires a registry + direct method calls. |

Each option should be evaluated with concrete plugin code examples showing what both the provider and consumer look like.

## Prerequisite 2: Dynamic Shell Panels

**Problem:** `Shell.Main` currently renders static contributions — one panel per plugin, decided at registration time. The terminal needs multiple dynamic panels (one per agent). Other future plugins (editors, logs) will have the same need.

**Needs its own design doc** covering:

- How `Shell.Main` evolves to support dynamic panel creation/destruction at runtime
- Tab bar or split view management
- Panel lifecycle (create, focus, close)
- How this interacts with whatever inter-plugin communication pattern is chosen (e.g., "open a panel" might itself be a command)

## File Structure (anticipated)

```
plugins/terminal/
├── web/
│   ├── index.ts                  # PluginDefinition
│   ├── commands.ts               # Terminal command definitions (depends on prereq 1)
│   ├── components/
│   │   └── claude-terminal.tsx   # Single Claude Code terminal instance (xterm.js)
│   └── hooks/
│       └── use-terminal.ts       # WebSocket + xterm lifecycle
├── server/
│   ├── index.ts                  # WsHandler for /ws/terminal
│   ├── pty-manager.ts            # PTY lifecycle (cwd-aware, claude command)
│   └── protocol.ts              # Message types
```

Note: no tab management here — that's the shell's job (prereq 2).

## Dependencies

- `@xterm/xterm`, `@xterm/addon-fit` in `web/package.json`
- `node-pty` in `server/package.json`

## Implementation Order

1. **Design: inter-plugin communication** → separate doc
2. **Design: dynamic shell panels** → separate doc (depends on #1)
3. **Build: terminal server plugin** — can start now, no frontend dependencies
4. **Build: terminal frontend plugin** — after #1 and #2 are resolved
5. **Design: session persistence / server-side buffering** → separate doc, future

## Verification (once all pieces land)

1. Server starts, accepts WebSocket connections at `/ws/terminal`
2. Opening a terminal spawns `claude` in the specified worktree directory
3. Multiple terminals can run in parallel (one per agent)
4. Another plugin can programmatically open a terminal for a given worktree
5. Terminals appear as dynamic panels in the shell, switchable via tabs
