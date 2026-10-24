# Config discoverability from in-context chips

## Context

Config that backs in-context UI is hard to find. To configure conversation
categories, preprompts, or prompt templates, a user has to know the settings
surface exists, open the **Config** sidebar, and hunt for the right section —
even though they are *looking right at* the chip that the config drives.

We want a "configure" affordance on these chips that jumps straight to the
relevant settings section. Crucially, we want a **generic** mechanism so that
future config-backed chips get this for free, without each chip's author having
to think about *where settings live* or *how to navigate there*.

### Key finding: the descriptor is already the link

All three target chips are backed by a `config_v2` `ConfigDescriptor`, each
registered via `ConfigV2.WebRegister`:

| Chip | Descriptor | Owning plugin |
|---|---|---|
| Conversation category | `conversationCategoryConfig` | `conversation-category` |
| Preprompt | `prepromptsConfig` | `preprompts` |
| Prompt templates | `promptTemplatesConfig` | `prompt-templates` |

`useConfigRegistrations()` already maps every registered descriptor →
`storePath`, and `configDetailPane` (segment `cd/:configPath`) already renders a
single descriptor's editor. So **a descriptor uniquely resolves to its settings
pane** — no new registry slot is needed. The generic mechanism is simply
"given a descriptor, open its config pane," exposed as a reusable engine and
surfaced as a popover-header primitive.

Decisions (confirmed with user):
- Build the **generic engine**, but **surface it inside popovers/expanded
  panels only** for now (not an always-visible header gear).
- Land on **all three chips**. For prompt-templates (no popover), the gear goes
  **top-left of the expanded floating panel** (the pen-icon hover panel).

## Design

### 1. Generic engine — new plugin `config_v2/plugins/config-link`

"Configure-this" deep-linking is a self-contained concern that will grow
(command-palette "Open settings for X" entries, inline "edit this setting"
affordances, config breadcrumbs, etc.), so it gets its own plugin under the
`config_v2` umbrella rather than living inside `settings`. `settings` keeps
ownership of the panes/editor; `config-link` is the thin, growable layer that
*navigates* to them.

The plugin is web-only with **no contributions** (like `icon-button`) — it
exists purely to export the engine + affordance components. DAG:
`chips → config-link → settings → config_v2`; `config-link` never imports the
chips, and `settings` never imports `config-link`.

**a. Export `configDetailPane`** from `plugins/config_v2/plugins/settings/web/index.ts`
(currently only `configNavPane` is exported) so `config-link` can target it.

**b. `useOpenConfig()` hook** — `plugins/config_v2/plugins/config-link/web/internal/use-open-config.ts`:

```ts
import { useCallback } from "react";
import { openPane } from "@plugins/primitives/plugins/pane/web";
import { useConfigRegistrations } from "@plugins/config_v2/web";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { configDetailPane } from "@plugins/config_v2/plugins/settings/web";

export function useOpenConfig() {
  const registrations = useConfigRegistrations();
  return useCallback(
    (descriptor: ConfigDescriptor) => {
      const reg = registrations.find((r) => r.descriptor === descriptor);
      if (!reg)
        throw new Error(
          `useOpenConfig: descriptor not registered via ConfigV2.WebRegister`,
        );
      openPane(
        configDetailPane,
        { configPath: encodeURIComponent(reg.storePath) },
        { mode: "root" }, // defaultAncestors:[configNavPane] → full nav+detail chain
      );
    },
    [registrations],
  );
}
```
- Match is by **reference equality** (`r.descriptor === descriptor`) — chips and
  the `WebRegister` contribution both reference the same module-level
  descriptor singleton, so this is robust and avoids name collisions.
- **Fails loud** if a descriptor was never registered (per repo coding rules).

**c. `<ConfigGearButton descriptor={...} />`** — `plugins/config_v2/plugins/config-link/web/components/config-gear-button.tsx`:
A reusable `IconButton` (`@plugins/primitives/plugins/icon-button/web`) with a
gear icon (`MdSettings`) + tooltip "Open settings", `onClick` →
`useOpenConfig()(descriptor)`. Drop-in anywhere (used directly by the templates
panel).

**d. `<ConfigPopoverHeader label descriptor />`** — `plugins/config_v2/plugins/config-link/web/components/config-popover-header.tsx`:
The convenience primitive for the dominant pattern. Composes the existing
`SectionLabel` + a trailing right-aligned `ConfigGearButton`:

```tsx
<div className="flex items-center justify-between gap-2">
  <SectionLabel className="...">{label}</SectionLabel>
  <ConfigGearButton descriptor={descriptor} />
</div>
```
This is the "no-thinking" convention: a config-backed popover swaps its bare
`SectionLabel` for `ConfigPopoverHeader` and the gear + navigation come for free.

Export `useOpenConfig`, `ConfigGearButton`, and `ConfigPopoverHeader` from the
`config-link` `web/index.ts` barrel (with a prose-only `CLAUDE.md`; the build
codegen inserts the reference block). Consumers import from
`@plugins/config_v2/plugins/config-link/web`.

### 2. Deploy in the three chips

**Category** — `plugins/conversations/plugins/conversation-category/web/components/category-chip-toolbar.tsx`:
Replace the `<SectionLabel>Set category</SectionLabel>` (line 85-87) with
`<ConfigPopoverHeader label="Set category" descriptor={conversationCategoryConfig} />`.
`conversationCategoryConfig` is already imported.

**Preprompt** — `plugins/conversations/plugins/conversation-preprompt/web/components/preprompt-chip.tsx`:
Replace `<SectionLabel>Preprompt instructions</SectionLabel>` (line 34-36) with
`<ConfigPopoverHeader label="Preprompt instructions" descriptor={prepromptsConfig} />`.
- **Barrel re-export required:** `prepromptsConfig` lives in
  `preprompts/shared/config.ts`; cross-plugin `shared/` imports are forbidden
  (R10). Add `export { prepromptsConfig } from "../shared/config";` to
  `plugins/conversations/plugins/preprompts/web/index.ts` (legal own-internal
  re-export). The chip then imports it from
  `@plugins/conversations/plugins/preprompts/web`.

**Prompt templates** — `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/web/components/prompt-template-chips.tsx`:
No popover; the expanded panel is the `FloatingActionFadeIn` (line 134-145, only
visible on pen-icon hover). Add a `<ConfigGearButton descriptor={promptTemplatesConfig} />`
as a top-left header element of the expanded panel. The panel is
`flex-col-reverse items-end`; place the gear so it reads top-left when expanded
(e.g. a small header row above the wrapped chips, left-aligned). `promptTemplatesConfig`
is already imported. Adjust the panel's `max-w`/`max-h` only if the gear needs
the extra room.

### Why no slot-prop / no new registry

A `Conversation.Header` slot prop (`configDescriptor`) or a dedicated
`ChipSettings.Link` slot were considered. Both are redundant: the descriptor
already self-identifies its settings location through the existing
`ConfigV2.WebRegister` registry. Adding another registry would duplicate that
mapping. The popover-header convention keeps the surface contextual (gear shows
when the user opens the chip's popover) and requires only that a chip pass the
descriptor it already holds.

## Files

New — `plugins/config_v2/plugins/config-link/`:
- `web/index.ts` — barrel: `export default { contributions: [] }` + exports of
  `useOpenConfig`, `ConfigGearButton`, `ConfigPopoverHeader`
- `web/internal/use-open-config.ts` — `useOpenConfig()`
- `web/components/config-gear-button.tsx` — `<ConfigGearButton/>`
- `web/components/config-popover-header.tsx` — `<ConfigPopoverHeader/>`
- `CLAUDE.md` — prose only (build inserts the autogen reference block)
- Register the plugin in `web/src/plugins.ts`

Modified:
- `plugins/config_v2/plugins/settings/web/index.ts` — export `configDetailPane`
- `plugins/conversations/plugins/preprompts/web/index.ts` — re-export `prepromptsConfig`
- `plugins/conversations/plugins/conversation-category/web/components/category-chip-toolbar.tsx`
- `plugins/conversations/plugins/conversation-preprompt/web/components/preprompt-chip.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/web/components/prompt-template-chips.tsx`

Reused (no change): `openPane` (`primitives/pane/web`), `useConfigRegistrations`
(`config_v2/web`), `IconButton` (`primitives/icon-button/web`), `SectionLabel`
(`primitives/section-label/web`), `configDetailPane`/`configNavPane` (settings).

## Verification

1. `./equin build` (regenerates docs; `plugins-doc-in-sync` +
   `plugin-boundaries` checks must pass — watch for the new `config-link`
   plugin registration/CLAUDE.md, the preprompts barrel re-export, and the
   `configDetailPane` export from settings).
2. Drive with Playwright (`e2e/screenshot.mjs`) against
   `http://<worktree>.localhost:9000`:
   - Open a non-agent conversation. Click the **category** chip → popover shows
     "Set category" with a gear top-right. Click gear → config nav+detail opens
     focused on `conversation-category`'s config.
   - Click the **preprompt** chip (on a conversation launched with a preprompt)
     → gear opens the preprompts library config.
   - Hover the **pen** icon in the prompt editor → expanded templates panel
     shows a gear top-left → opens the prompt-templates config.
3. Confirm `useOpenConfig` throws (visible error) if handed an unregistered
   descriptor — i.e. the failure is loud, not silent.
