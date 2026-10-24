# Command Permissions Attachment Renderer Sub-Plugin

## Context

The `attachment` umbrella plugin at `jsonl-viewer/plugins/attachment/` dispatches attachment events to sub-plugins by `subtype`. Four sub-plugins exist (`deferred-tools-delta`, `nested-memory`, `skill-listing`, `task-reminder`), but `command_permissions` events still fall through to the generic JSON dump fallback. This plan adds a dedicated renderer.

The payload (from real transcripts):
```json
{ "type": "command_permissions", "allowedTools": ["Bash(rg:read-only)", "Read", ...] }
```

`allowedTools` is a string array — each entry is a tool name, optionally with a parenthetical qualifier (e.g. `Bash(npm test:read-only)`).

## Files to create

All under `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/plugins/command-permissions/`:

### 1. `package.json`

Minimal workspace entry — copy the shape from `skill-listing/package.json`, substitute the name:

```json
{
  "name": "@singularity/plugin-conversations-conversation-view-jsonl-viewer-attachment-command-permissions",
  "private": true,
  "version": "0.0.1"
}
```

### 2. `web/index.ts`

Plugin barrel. Single `JsonlViewerAttachment.Renderer` contribution with `subtype: "command_permissions"`.

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerAttachment } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { CommandPermissionsView } from "./components/command-permissions-view";

export default {
  id: "conversation-jsonl-viewer-attachment-command-permissions",
  name: "JSONL Viewer: command-permissions attachment renderer",
  collapsed: true,
  description: "Renders command-permissions attachment events showing permission grants for the session.",
  contributions: [
    JsonlViewerAttachment.Renderer({
      subtype: "command_permissions",
      component: CommandPermissionsView,
    }),
  ],
} satisfies PluginDefinition;
```

### 3. `web/components/command-permissions-view.tsx`

Collapsible section following the established pattern (same wrapper div, button trigger, collapsible body). Header: "Command Permissions (N)" where N is the count. Body: monospace list of tool names.

Locally defined payload interface:

```ts
interface CommandPermissionsPayload {
  type: "command_permissions";
  allowedTools: string[];
}
```

Renders each tool as a monospace line, identical to how `deferred-tools-delta` lists tool names. Empty state: italic "No permissions granted."

## Verification

1. Build: `./equin build`
2. Open conversation `conv-1779695590-m6pd` at `http://att-1779724174-kvak.localhost:9000` and scroll to the `command_permissions` attachment event — it should render with the collapsible "Command Permissions" header instead of a raw JSON dump.
3. Run `./equin check --plugin-boundaries` and `./equin check --plugins-doc-in-sync` — both must pass.
