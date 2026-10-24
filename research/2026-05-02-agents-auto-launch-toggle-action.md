# Agent Row Actions: Auto-Launch Toggle Sub-Plugin

## Context

The `Agents.AgentActions` slot already exists and is wired into `AgentRow` — it renders zero-or-more action buttons revealed on hover, passed via `RowChrome`'s `actions` prop. No plugin currently contributes to it.

The request is to:
1. Confirm the slot mechanism is in place (it is).
2. Add a first row action — an **auto-launch toggle** — as a dedicated sub-plugin under `plugins/agents/plugins/auto-launch/`.
3. The toggle is **no-op for now** (no schema field, no API call; local visual state only).
4. Each future row action will be its own sub-plugin.

---

## Architecture

### Existing extension points (nothing to change)

- **`plugins/agents/web/slots.ts`** — defines `Agents.AgentActions` slot:  
  ```ts
  AgentActions: defineSlot<{ id: string; component: ComponentType<{ agentId: string }> }>("agents.agent-actions")
  ```
- **`plugins/agents/web/components/agents-list.tsx`** — `AgentRow` already calls `Agents.AgentActions.useContributions()` and maps each to `<act.component agentId={node.id} />` inside `RowChrome`.

### Reference pattern

`plugins/tasks/plugins/task-list/` is the canonical example: slots defined in the parent, each action its own file in `components/`, all contributed in the top-level `index.ts`. The delete-task action is the simplest model.

---

## Files to Create

```
plugins/agents/plugins/auto-launch/
├── package.json
└── web/
    ├── index.ts
    └── components/
        └── auto-launch-toggle.tsx
```

### `package.json`

```json
{
  "name": "@singularity/plugin-agents-auto-launch",
  "private": true,
  "version": "0.0.1"
}
```

### `web/index.ts` — barrel + plugin definition

```ts
import type { PluginDefinition } from "@core";
import { Agents } from "@plugins/agents/web";
import { AutoLaunchToggle } from "./components/auto-launch-toggle";

export default {
  id: "agents-auto-launch",
  name: "Agents: Auto-Launch Toggle",
  description: "Toggle on/off to activate agent auto-launch (no-op; placeholder for future wiring).",
  contributions: [
    Agents.AgentActions({ id: "auto-launch", component: AutoLaunchToggle }),
  ],
} satisfies PluginDefinition;
```

### `web/components/auto-launch-toggle.tsx` — the toggle component

- Renders a small icon button using the same size/style as `DeleteTaskAction` (`size-6 rounded hover:bg-background/60`).
- Uses `useState(false)` to track on/off state locally (no-op — resets when the tree is unmounted). This gives the toggle a real visual feel without any backend wiring.
- Icon: `MdRocketLaunch` (off) / `MdRocketLaunch` with full opacity (on), or a power-style icon — use `MdPlayArrow` for off, highlight for on. Actually, use `LuZap` or `MdAutoMode`. A simple approach: `MdRocketLaunch` always, with `opacity-40` when off, full opacity and accent color when on.
- Tooltip: `"Auto-launch: off"` / `"Auto-launch: on"`.
- `e.stopPropagation()` to prevent row selection.

```tsx
import { useState } from "react";
import { MdRocketLaunch } from "react-icons/md";
import { cn } from "@/lib/utils";

export function AutoLaunchToggle({ agentId: _agentId }: { agentId: string }) {
  const [enabled, setEnabled] = useState(false);

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setEnabled((v) => !v); }}
      title={enabled ? "Auto-launch: on" : "Auto-launch: off"}
      aria-label="Toggle auto-launch"
      aria-pressed={enabled}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded hover:bg-background/60",
        enabled ? "text-blue-500" : "opacity-40",
      )}
    >
      <MdRocketLaunch className="size-4" />
    </button>
  );
}
```

---

## No Schema / Server Changes

The `AgentSchema` in `plugins/agents/shared/schemas.ts` has no `autoLaunch` field. Since the toggle is no-op, no migration, no DB column, and no server barrel change is needed. The `_agentId` prop is accepted but unused (prefixed to suppress lint).

---

## Auto-Registration

`./equin build` auto-discovers `plugins/agents/plugins/auto-launch/web/index.ts` (via `cli/src/plugin-registry-gen.ts`) and adds an import + entry to `web/src/plugins.generated.ts`. No manual edit needed.

---

## Verification

1. Run `./equin build` — build should succeed, no migration generated.
2. Open `http://att-1777708907-0x08.localhost:9000` and navigate to the Agents sidebar.
3. Hover over any agent row — the rocket icon button should appear on the right.
4. Click it — it should toggle blue (on) / dim (off).
5. `./equin check` should pass (no boundary violations: `@plugins/agents/web` is a legal cross-plugin import from the sub-plugin).
