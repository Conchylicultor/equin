# model-provider plugin

## Context

`ConversationModel` (`"opus" | "sonnet"`) is the logical identifier for which Claude model a conversation runs on. Currently:

- The type and Zod schema are defined in `plugins/conversations/server/schema.ts`, re-exported through two barrels, and duplicated locally in `tasks-core` (to keep it a dep-leaf).
- The CLI flag passed to `claude --model` is the enum value verbatim (`--model opus`), delegating version resolution to the Claude CLI alias — making it impossible to pin a specific version from the codebase.
- Display metadata (label, icon size) is hardcoded in three separate UI components.

The goal: a single `model-provider` shared plugin that is the **only** source of truth. No re-exports through parent barrels — every consumer imports directly from `@plugins/conversations/plugins/model-provider/shared`. Switching Opus 4.7 → 4.6 becomes a one-line change.

`tasks-core` can safely import from `model-provider` (no cycle: `model-provider` has zero plugin deps).

`run-claude-print.ts` (haiku/sonnet/opus `--print` calls) is out of scope.

---

## New plugin: `plugins/conversations/plugins/model-provider/`

Shared-only — no DB tables, no HTTP routes, no UI contributions. Not registered in `web/src/plugins.ts` or `server/src/plugins.ts`.

### `package.json`

```json
{
  "name": "@singularity/plugin-conversations-model-provider",
  "private": true,
  "version": "0.0.1"
}
```

### `shared/registry.ts`

```ts
import { z } from "zod";

export const ConversationModelSchema = z.enum(["opus", "sonnet"]);
export type ConversationModel = z.infer<typeof ConversationModelSchema>;

export const DEFAULT_MODEL: ConversationModel = "opus";

export type ModelMeta = {
  cliFlag: string;   // exact model ID passed to claude --model
  label: string;     // display name
  iconSize: string;  // tailwind size class
};

export const MODEL_REGISTRY: Record<ConversationModel, ModelMeta> = {
  opus:   { cliFlag: "claude-opus-4-6",   label: "Opus",   iconSize: "size-4" },
  sonnet: { cliFlag: "claude-sonnet-4-6", label: "Sonnet", iconSize: "size-3" },
};
```

### `shared/index.ts`

```ts
export {
  ConversationModelSchema,
  DEFAULT_MODEL,
  MODEL_REGISTRY,
} from "./registry";
export type { ConversationModel, ModelMeta } from "./registry";
```

---

## Files to delete

- `plugins/conversations/server/schema.ts` — entire file; only contained `ConversationModel` definition.

---

## Files to modify

### `tasks-core/server/internal/tables.ts`

Replace the local type (line 95) with an import:

```ts
// remove:
type ConversationModel = "opus" | "sonnet";

// add:
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/shared";
```

### `tasks-core/server/internal/schema.ts`

Replace the local schema (line 190) with an import:

```ts
// remove:
const ConversationModelSchema = z.enum(["opus", "sonnet"]);

// add:
import { ConversationModelSchema } from "@plugins/conversations/plugins/model-provider/shared";
```

### `conversations/server/index.ts`

Remove the two lines re-exporting from `./schema`:

```ts
// remove:
export { ConversationModelSchema } from "./schema";
export type { ConversationModel } from "./schema";
```

### `conversations/shared/index.ts`

Remove the re-export line:

```ts
// remove:
export { ConversationModelSchema, type ConversationModel } from "../server/schema";
```

### `conversations/server/internal/lifecycle.ts`

```ts
// remove:
import type { ConversationModel } from "../schema";
const DEFAULT_MODEL: ConversationModel = "opus";

// add:
import { DEFAULT_MODEL, type ConversationModel } from "@plugins/conversations/plugins/model-provider/shared";
```

### `conversations/server/internal/handle-create.ts`

```ts
// remove:
import { ConversationModelSchema } from "../schema";

// add:
import { ConversationModelSchema } from "@plugins/conversations/plugins/model-provider/shared";
```

### `conversations/server/internal/tables-created-event.ts`

```ts
// remove:
import type { ConversationModel } from "../schema";

// add:
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/shared";
```

### `conversations/server/internal/runtime.ts`

Replace the inline dynamic import (line 30):

```ts
// remove:
model?: import("../schema").ConversationModel;

// add:
model?: import("@plugins/conversations/plugins/model-provider/shared").ConversationModel;
```

### `runtime-tmux/server/internal/tmux-runtime.ts`

```ts
// remove:
import type { ConversationModel } from "@plugins/conversations/server";
const claudeBase = opts?.model ? `${CLAUDE} --model ${opts.model}` : CLAUDE;

// add:
import { MODEL_REGISTRY, type ConversationModel } from "@plugins/conversations/plugins/model-provider/shared";
const cliFlag = opts?.model ? MODEL_REGISTRY[opts.model].cliFlag : undefined;
const claudeBase = cliFlag ? `${CLAUDE} --model ${cliFlag}` : CLAUDE;
```

### `agents/server/internal/handle-launch.ts`

```ts
// remove:
import { ConversationModelSchema, type ConversationModel } from "@plugins/conversations/shared";

// add:
import { ConversationModelSchema, type ConversationModel } from "@plugins/conversations/plugins/model-provider/shared";
```

### `primitives/plugins/launch/web/components/launch-buttons.tsx`

```ts
// remove:
import { type ConversationModel, ... } from "@plugins/conversations/shared";
const MODELS: ConversationModel[] = ["sonnet", "opus"];
const LABEL: Record<ConversationModel, string> = { sonnet: "Sonnet", opus: "Opus" };
const ICON_SIZE: Record<ConversationModel, string> = { sonnet: "size-3", opus: "size-4" };

// add:
import { MODEL_REGISTRY, type ConversationModel } from "@plugins/conversations/plugins/model-provider/shared";
const MODELS = Object.keys(MODEL_REGISTRY) as ConversationModel[];
// use MODEL_REGISTRY[model].label and MODEL_REGISTRY[model].iconSize inline
```

### `conversation-view/plugins/fork-conversation/web/components/fork-conversation-action.tsx`

Same pattern as launch-buttons: replace `MODELS` + `ICON_SIZE` constants with `MODEL_REGISTRY` imports.

### `conversation-view/plugins/fork-session/web/components/fork-session-action.tsx`

Same pattern.

### `conversation-view/plugins/model/web/components/model-badge.tsx`

```ts
// remove:
import type { ConversationModel } from "@plugins/conversations/shared";

// add:
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/shared";
```

(MODEL_CLASSES are identical for both models — no registry lookup needed here.)

---

## Summary of consumer import changes

| Consumer | Old import | New import |
|---|---|---|
| `tasks-core/internal/tables.ts` | local type | `model-provider/shared` |
| `tasks-core/internal/schema.ts` | local schema | `model-provider/shared` |
| `conversations/.../lifecycle.ts` | `../schema` | `model-provider/shared` |
| `conversations/.../handle-create.ts` | `../schema` | `model-provider/shared` |
| `conversations/.../tables-created-event.ts` | `../schema` | `model-provider/shared` |
| `conversations/.../runtime.ts` | inline `../schema` | inline `model-provider/shared` |
| `runtime-tmux/.../tmux-runtime.ts` | `conversations/server` | `model-provider/shared` |
| `agents/.../handle-launch.ts` | `conversations/shared` | `model-provider/shared` |
| `launch/web/launch-buttons.tsx` | `conversations/shared` | `model-provider/shared` |
| `fork-conversation-action.tsx` | `conversations/shared` | `model-provider/shared` |
| `fork-session-action.tsx` | `conversations/shared` | `model-provider/shared` |
| `model-badge.tsx` | `conversations/shared` | `model-provider/shared` |

---

## Verification

```bash
./equin build        # build + type-check + migrations
./equin check        # plugin boundary + eslint checks
```

Spot-check: launch a new Opus conversation, open the tmux pane, and confirm:
```bash
ps aux | grep claude   # should show --model claude-opus-4-6
```
