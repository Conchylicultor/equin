# Move `captureUrlByDefault` from a hardcoded app flag to a per-app config scope

## Context

The task-draft form pre-checks a "URL" capture toggle so the current page URL
is attached as task context. Whether it starts checked is decided per-app by
`captureUrlByDefault` — a static boolean on the `Apps.App` slot contribution,
read through `useActiveApp()`. Today exactly one app sets it: the agent manager
opts out with `captureUrlByDefault: false` (you author tasks there, so its own
URL is not useful context). Every other app relies on the `undefined → true`
default.

This is a code constant living **outside** the config system: not
version-controlled as config, not user-overridable, and bolted onto an
unrelated slot type. `config_v2` now supports **git-expressed per-app config
scopes** (`config/<plugin-tree>/@app/<id>/<name>.jsonc`), and there is not yet a
single real consumer of that capability. This change makes the capture-URL
default the first one: a typed `boolField` owned by `task-draft-form`, defaulting
to `true`, with the agent-manager opt-out expressed as a committed per-app scope
delta instead of a hardcoded flag — so the value is version-controlled per app
AND user-overridable through the config system.

The reference precedent for the whole shape is the **floating-bar** plugin:
a `defineConfig` in `shared/config.ts`, a thin `server/index.ts` that registers
it via `ConfigV2.Register`, and a committed `config/floating-bar/config.origin.jsonc`.

## Current state (precise)

- **Type declaration:** `plugins/apps/web/slots.ts:30-35` — optional
  `captureUrlByDefault?: boolean` on the `defineRenderSlot<{…}>("apps.app", …)`
  contribution shape.
- **Only setter:** `plugins/apps/plugins/agent-manager/plugins/shell/web/index.ts:10-22`
  — `captureUrlByDefault: false` (+ explanatory comment).
- **Reader:** `plugins/tasks/plugins/task-draft-form/web/use-capture-url-default.ts`
  — `useCaptureUrlDefault()` returns `useActiveApp()?.captureUrlByDefault ?? true`.
- **Consumers of the hook (unchanged by this plan):**
  - `…/task-draft-form/web/components/task-draft-form.tsx:129-148`
  - `…/task-draft-form/web/components/task-draft-popover.tsx:246-251`
  Both already guard with `captures.includes("url")`; they only call the hook.
- `task-draft-form` currently has **no `server/` and no `shared/`** runtime —
  only `core/` (empty barrel) and `web/`.

## Design decisions

- **Owner = `task-draft-form`**, not `apps`. The behavior is a task-draft
  concern; the form already owns the hook. `apps` should not carry a field that
  only one downstream plugin reads.
- **No `scope: "app"` marker on the descriptor.** Per `config_v2/CLAUDE.md`
  (lines 67–83), a committed `@app/<id>` override resolves on read regardless of
  that marker — `useConfig`'s scoped branch keys off `hasCommittedScope`, not the
  marker. The `scope: "app"` marker only enrolls a descriptor in the theme
  "Customize for app" *fork-all-descriptors* UX; adding it here would wrongly
  couple this config to theme forking. Mirror floating-bar: omit it. The
  committed git scope is the override mechanism we want.
- **Field key = `captureUrlByDefault`**, default `true`. (The config_v2 CLAUDE.md
  per-app example literally uses `{ "captureUrlByDefault": false }` — same name.)

## Implementation

### 1. New config descriptor — `plugins/tasks/plugins/task-draft-form/shared/config.ts`

Mirror `plugins/floating-bar/shared/config.ts` byte-for-byte in shape:

```ts
import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";

export const taskDraftConfig = defineConfig({
  fields: {
    captureUrlByDefault: boolField({
      default: true,
      label: "Pre-check URL capture",
      description:
        "When drafting a task from inside an app, pre-check the “URL” capture toggle so the current page URL is attached as task context. Apps where you author tasks rather than inspect subject matter (e.g. the Agent Manager) override this to false.",
    }),
  },
});
```

Default config name is `config` → files land at `config/tasks/task-draft-form/config[.origin].jsonc`.

### 2. New server barrel — `plugins/tasks/plugins/task-draft-form/server/index.ts`

Mirror `plugins/floating-bar/server/index.ts`:

```ts
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { taskDraftConfig } from "../shared/config";

export default {
  description:
    "Reusable popover + chain form for drafting one or more tasks. Powers the Improve toolbar button and the conversation new-child-task button.",
  contributions: [ConfigV2.Register({ descriptor: taskDraftConfig })],
} satisfies ServerPluginDefinition;
```

No `package.json` change needed (floating-bar registers config with an empty
`dependencies`; `@plugins/*` imports resolve via workspace tsconfig paths). The
build's codegen auto-discovers the new server barrel and adds it to
`plugins/framework/plugins/server-core/core/server.generated.ts` with
`dependsOn: ["config_v2"]` — **do not** hand-edit that generated file.

### 3. Register the descriptor on web — `…/task-draft-form/web/index.ts`

`useConfig` needs **both** a server registration (snapshot) and a web
registration (storePath); it throws loudly if either is missing. Add the web
side to the existing barrel's `contributions` array (mirror floating-bar's
`web/index.ts`):

```ts
import { ConfigV2 } from "@plugins/config_v2/web";
import { taskDraftConfig } from "../shared/config";
// …
contributions: [ConfigV2.WebRegister({ descriptor: taskDraftConfig })],
```

### 4. Rewrite the reader — `…/task-draft-form/web/use-capture-url-default.ts`

```ts
import { useCurrentAppId } from "@plugins/apps/web";
import { useConfig } from "@plugins/config_v2/web";
import { taskDraftConfig } from "../shared/config";

/**
 * Whether new draft cards should pre-check the "URL" capture toggle. Read from
 * the task-draft config, scoped to the app the form is rendered in: most apps
 * keep the `true` default, an app opts out via a committed per-app config
 * override (e.g. the agent manager → false). The form stays contributor-agnostic
 * — config_v2 is app-agnostic and the scope is threaded by app id, not by name.
 */
export function useCaptureUrlDefault(): boolean {
  const appId = useCurrentAppId();
  const scopeId = appId ? `app:${appId}` : undefined;
  return useConfig(taskDraftConfig, { scopeId }).captureUrlByDefault;
}
```

`useCurrentAppId` (`@plugins/apps/web`) is the canonical id-only wrapper over
`useActiveApp`. The `appId ? \`app:${appId}\` : undefined` form matches the
existing read-only consumers (variant-region-host, theme-injector); `useConfig`
internally falls back to the global/base value for any un-committed scope.
(Optionally use `appScopeId(appId)` from `@plugins/config_v2/core` instead of the
inline template — same result.)

### 5. Drop the slot field — `plugins/apps/web/slots.ts`

Remove the `captureUrlByDefault?: boolean` member (lines 30–35) and its doc
comment from the `apps.app` contribution shape.

### 6. Drop the setter — `…/agent-manager/plugins/shell/web/index.ts`

Remove `captureUrlByDefault: false` (and its comment) from the `Apps.App({…})`
contribution (lines ~18–22).

### 7. Commit the agent-manager per-app override (git scope)

This is the replacement for the deleted constant. Two-step because the override
must carry the base origin's hash:

1. Run `./equin build` once so codegen writes the base origin
   `config/tasks/task-draft-form/config.origin.jsonc` (first line `// @hash <12-hex>`).
2. Create `config/tasks/task-draft-form/@app/agent-manager/config.jsonc`:
   ```jsonc
   // @hash <copied-from-config.origin.jsonc>
   {
     "captureUrlByDefault": false
   }
   ```
   Partial delta is fine — schema default-backfill fills the rest. The scoped
   override anchors to the **base** origin; no scoped origin is ever committed.
3. Run `./equin build` again. Propagation resolves the scope as
   `baseEffective ⊕ delta` and pre-hydrates it in the boot snapshot, so the
   agent-manager paints `false` on the first frame (no flash).

## Files to change

| Action | Path |
|---|---|
| **new** | `plugins/tasks/plugins/task-draft-form/shared/config.ts` |
| **new** | `plugins/tasks/plugins/task-draft-form/server/index.ts` (registers `ConfigV2.Register`) |
| edit | `plugins/tasks/plugins/task-draft-form/web/index.ts` (add `ConfigV2.WebRegister`) |
| edit | `plugins/tasks/plugins/task-draft-form/web/use-capture-url-default.ts` |
| edit | `plugins/apps/web/slots.ts` (remove field + comment) |
| edit | `plugins/apps/plugins/agent-manager/plugins/shell/web/index.ts` (remove setter + comment) |
| **new** | `config/tasks/task-draft-form/@app/agent-manager/config.jsonc` (after first build) |
| generated | `config/tasks/task-draft-form/config.origin.jsonc` (by build) |
| generated | `plugins/framework/plugins/server-core/core/server.generated.ts` (by build — do not hand-edit) |

## Verification

1. `./equin build` (twice, per step 6) — confirm origin + server registration generate cleanly.
2. `./equin check config-origins-in-sync` — validates the `@app` override's `// @hash` against the base origin and the doc against the schema.
3. `./equin check type-check plugin-boundaries` — confirms the field removal has no stragglers and the new server barrel obeys boundary rules.
4. End-to-end via Playwright (`e2e/screenshot.mjs`):
   - In a **non-agent-manager** app (e.g. `http://<wt>.localhost:9000/pages`), open the Improve / task-draft popover and confirm the **URL toggle is pre-checked** (global default `true`).
   - In the **agent manager** (`http://<wt>.localhost:9000/agents`), open the task-draft popover and confirm the **URL toggle is unchecked** (committed `app:agent-manager` scope → `false`). This reproduces the exact behavior the deleted constant produced.
5. Optional regression: the base value is now user-editable in the config settings pane (base scope) — flipping it there changes the default for all non-overridden apps.

## Out of scope / notes

- **Runtime per-app user override UI** is not delivered here: config_v2's settings
  detail pane is base-scoped today (the CLAUDE.md "Not yet wired" note), and the
  only runtime scoped-fork path is the theme "Customize for app" button, which is
  theme-specific. This plan makes the per-app default **version-controlled** (git
  scope) and the base value **user-overridable** (settings) — matching what the
  platform supports now. A generic per-scope settings surface is a separate follow-up.
