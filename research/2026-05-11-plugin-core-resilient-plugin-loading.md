# Resilient Plugin Loading (web)

## Context

`web/src/plugins.generated.ts` uses ~120 static ES `import` statements. If any
plugin module throws during evaluation (top-level code), the entire bundle fails
and the app renders a white screen. The register phase (`plugin-core/context.tsx`)
and render phase (`PluginErrorBoundary`) already have per-plugin error isolation.
Module evaluation is the remaining unguarded gap.

`import.meta.glob({ eager: true })` does NOT help — Vite transforms it into
static imports at build time, same vulnerability. The only way to isolate module
evaluation errors is dynamic `import()`.

**Scope: web runtime only.** Server/central are deliberately fail-fast (server
comment: "A failure here is fatal"). Server crashes are auto-restarted by the
gateway.

## Design

Replace static imports in the generated web registry with dynamic `import()`
calls. A `loadPlugins()` function uses `Promise.allSettled` to load all plugins
in parallel, catches per-plugin failures, and returns both the successful plugins
and a list of errors. App.tsx gains a brief async loading phase and renders a
persistent error banner when any plugins failed to load.

**Type safety preserved:** each `() => import("@plugins/foo/web")` is typed as
`() => Promise<{ default: PluginDefinition }>` — TypeScript checks each module's
default export at compile time.

**Cascading failures handled correctly:** if plugin A fails and plugin B imports
from A, both B's import and A's import reject independently. Both appear in the
errors list.

## Changes

### 1. `plugin-core/loader.ts` (new)

```ts
import type { PluginDefinition } from "./types";

export interface PluginEntry {
  name: string;
  loader: () => Promise<{ default: PluginDefinition }>;
}

export interface PluginLoadError {
  name: string;
  error: unknown;
}

export async function loadPlugins(
  entries: PluginEntry[],
): Promise<{ plugins: PluginDefinition[]; errors: PluginLoadError[] }> {
  const results = await Promise.allSettled(
    entries.map((e) => e.loader()),
  );
  const plugins: PluginDefinition[] = [];
  const errors: PluginLoadError[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const entry = entries[i]!;
    if (result.status === "fulfilled") {
      plugins.push(result.value.default);
    } else {
      console.error(`[plugin.${entry.name}] failed to load`, result.reason);
      errors.push({ name: entry.name, error: result.reason });
    }
  }
  return { plugins, errors };
}
```

Re-export from `plugin-core/index.ts`:
```ts
export type { PluginEntry, PluginLoadError } from "./loader";
export { loadPlugins } from "./loader";
```

### 2. `cli/src/plugin-registry-gen.ts` — web runtime branch

Add a branch inside `renderPluginRegistry` for `opts.runtime === "web"` that
generates the new entry-descriptor format. Server/central paths unchanged.

New generated format:
```ts
import type { PluginDefinition } from "@core";

export interface PluginEntry {
  name: string;
  loader: () => Promise<{ default: PluginDefinition }>;
}

export const pluginEntries: PluginEntry[] = [
  { name: "active-data/plugins/attempt", loader: () => import("@plugins/active-data/plugins/attempt/web") },
  // ... 120+ entries sorted alphabetically
];
```

The `PluginEntry` interface is inlined in the generated file so it's
self-contained and type-checkable without extra imports.

The `name` field is derived from the import path: `@plugins/foo/bar/web` →
`foo/bar` (strip prefix and `/web` suffix).

### 3. `web/src/plugins.ts`

```ts
export { pluginEntries } from "./plugins.generated";
export type { PluginEntry } from "./plugins.generated";
```

### 4. `web/src/App.tsx`

```tsx
import { useState, useEffect } from "react";
import { PluginProvider, Core, loadPlugins } from "@core";
import type { PluginDefinition, PluginLoadError } from "@core";
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import { NotificationsProvider } from "@plugins/primitives/plugins/live-state/web";
import { pluginEntries } from "./plugins";
import { PluginLoadErrors } from "./components/plugin-load-errors";

function RootRenderer() {
  const roots = Core.Root.useContributions();
  return (
    <>
      {roots.map((r, i) => (
        <PluginErrorBoundary key={i} slot="core.root">
          <r.component />
        </PluginErrorBoundary>
      ))}
    </>
  );
}

export default function App() {
  const [state, setState] = useState<{
    plugins: PluginDefinition[];
    errors: PluginLoadError[];
  } | null>(null);

  useEffect(() => {
    loadPlugins(pluginEntries).then(setState);
  }, []);

  if (!state) return null;

  return (
    <>
      {state.errors.length > 0 && <PluginLoadErrors errors={state.errors} />}
      <NotificationsProvider>
        <PluginProvider plugins={state.plugins}>
          <RootRenderer />
        </PluginProvider>
      </NotificationsProvider>
    </>
  );
}
```

The `null` render during loading is a single frame — plugins are bundled, not
fetched from CDN.

The error banner is rendered **outside** `PluginProvider` so it works even if
every plugin fails to load.

### 5. `web/src/components/plugin-load-errors.tsx` (new)

Simple component, not a plugin (chicken-and-egg: if the banner plugin failed to
load, no banner). Matches the existing `PluginErrorBoundary` styling.

```tsx
import type { PluginLoadError } from "@core";

export function PluginLoadErrors({ errors }: { errors: PluginLoadError[] }) {
  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex flex-col gap-1 p-2">
      {errors.map((e, i) => (
        <div
          key={i}
          className="flex items-center gap-2 rounded-md border border-destructive/20
                     bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span className="font-medium">Plugin failed to load:</span>
          <span className="font-mono">{e.name}</span>
          <span className="truncate text-destructive/70">
            {e.error instanceof Error ? e.error.message : String(e.error)}
          </span>
        </div>
      ))}
    </div>
  );
}
```

### 6. `web/src/__tests__/plugin-render.test.tsx`

The test currently iterates `plugins` synchronously at describe time. With async
loading, switch to a single async test that loads then iterates:

```tsx
import { it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PluginProvider, loadPlugins } from "@core";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { pluginEntries } from "../plugins";

const SIDEBAR_SLOTS = new Set(["shell.sidebar"]);
const SHELL_SLOTS = new Set(["core.root"]);

function Wrapper({
  slotId,
  children,
  plugins,
}: {
  slotId: string;
  children: React.ReactNode;
  plugins: any[];
}) {
  let content = <>{children}</>;
  if (SIDEBAR_SLOTS.has(slotId)) content = <SidebarProvider>{content}</SidebarProvider>;
  if (SHELL_SLOTS.has(slotId)) content = <TooltipProvider>{content}</TooltipProvider>;
  return <PluginProvider plugins={plugins}>{content}</PluginProvider>;
}

it("plugin contributions render without crashing", async () => {
  const { plugins, errors } = await loadPlugins(pluginEntries);
  expect(errors).toHaveLength(0);
  for (const plugin of plugins) {
    for (const contribution of plugin.contributions ?? []) {
      const slotId = (contribution as any)._slotId as string;
      const Component = (contribution as any).component as React.ComponentType | undefined;
      if (!Component) continue;
      expect(() => {
        render(
          <Wrapper slotId={slotId} plugins={plugins}>
            <Component />
          </Wrapper>,
        );
      }).not.toThrow();
    }
  }
});
```

### 7. `plugin-core/CLAUDE.md` — update "Key Design Decisions"

Change:
> No dynamic loading — plugins are statically imported, known at build time

To:
> Web plugins use dynamic `import()` for per-plugin error isolation; server/central
> use static imports. All plugins are known at build time (the generated registry
> lists them).

## Performance

- **Production:** Vite bundles dynamic imports into chunks and preloads them. No
  extra network round-trips vs the current single-chunk approach.
- **Dev mode:** ~120 HTTP/2 multiplexed requests to Vite dev server, ~50-100ms.
  Imperceptible.
- **No loading spinner needed:** the `null` render is a single frame.

## Verification

1. `./equin build` → `web/src/plugins.generated.ts` has `pluginEntries` array format
2. `./equin check --plugins-registry-in-sync` → passes
3. `bun run build` in `web/` → TypeScript + Vite compile cleanly
4. Load app → works identically, no banner, no console errors
5. Add `throw new Error("boom")` to a non-critical plugin (e.g. `plugins/theme/web/index.ts`) → app loads without it, banner shows the failure
6. Change a plugin's default export to `export default 42` → `tsc` reports type error
7. `bun run test` in `web/` → test passes

## Files

| File | Action |
|------|--------|
| `plugin-core/loader.ts` | **new** — `loadPlugins`, `PluginEntry`, `PluginLoadError` |
| `plugin-core/index.ts` | add re-exports |
| `cli/src/plugin-registry-gen.ts` | web branch in `renderPluginRegistry` |
| `web/src/plugins.generated.ts` | auto-regenerated by build |
| `web/src/plugins.ts` | export `pluginEntries` instead of `plugins` |
| `web/src/App.tsx` | async loading phase + error banner |
| `web/src/components/plugin-load-errors.tsx` | **new** — error banner component |
| `web/src/__tests__/plugin-render.test.tsx` | async `loadPlugins` pattern |
| `plugin-core/CLAUDE.md` | update design decisions note |
