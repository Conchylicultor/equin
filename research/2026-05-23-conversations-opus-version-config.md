# Opus version config_v2 field

## Context

The Opus CLI flag is hardcoded to `claude-opus-4-6` in `model-provider/core/registry.ts`. Opus 4.7 is available but switching requires a code change. Adding a config_v2 enum field lets the user toggle Opus versions from the Settings UI. Sonnet (4.6 only) and Haiku (4.5, used by `--print`) are unaffected.

## Plan

### 1. Create `shared/config.ts`

**New file:** `plugins/conversations/plugins/model-provider/shared/config.ts`

```ts
import { defineConfig } from "@plugins/config_v2/core";
import { enumField } from "@plugins/config_v2/plugins/fields/plugins/enum/core";

export const modelProviderConfig = defineConfig({
  fields: {
    opusVersion: enumField({
      label: "Opus version",
      description: "Claude Opus model version for new conversations.",
      options: [
        { value: "4-6", label: "Opus 4.6" },
        { value: "4-7", label: "Opus 4.7" },
      ],
      default: "4-6",
    }),
  },
});
```

### 2. Create `server/internal/resolve-cli-flag.ts`

Encapsulates the config-aware cliFlag lookup. Exported through the server barrel.

```ts
import { getConfig } from "@plugins/config_v2/server";
import { MODEL_REGISTRY, type ConversationModel } from "../../core";
import { modelProviderConfig } from "../../shared/config";

const OPUS_CLI_FLAGS: Record<string, string> = {
  "4-6": "claude-opus-4-6",
  "4-7": "claude-opus-4-7",
};

export function resolveCliFlag(model: ConversationModel): string {
  if (model === "opus") {
    const { opusVersion } = getConfig(modelProviderConfig);
    return OPUS_CLI_FLAGS[opusVersion]!;
  }
  return MODEL_REGISTRY[model].cliFlag;
}
```

### 3. Update `server/index.ts`

Add `ConfigV2.Register` contribution and re-export `resolveCliFlag`.

```ts
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { modelProviderConfig } from "../shared/config";

export { resolveCliFlag } from "./internal/resolve-cli-flag";

export default {
  id: "conversations-model-provider",
  name: "Model Provider",
  description: "...",
  contributions: [
    ConfigV2.Register({ descriptor: modelProviderConfig }),
  ],
} satisfies ServerPluginDefinition;
```

### 4. Update `web/index.ts`

Add `ConfigV2.WebRegister` contribution.

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { modelProviderConfig } from "../shared/config";

export default {
  id: "conversations-model-provider",
  name: "Model Provider",
  description: "...",
  contributions: [
    ConfigV2.WebRegister({ descriptor: modelProviderConfig }),
  ],
} satisfies PluginDefinition;
```

### 5. Update `runtime-tmux/server/internal/tmux-runtime.ts`

Replace the static `MODEL_REGISTRY` lookup with the dynamic `resolveCliFlag` call.

**Before (line 5, 234):**
```ts
import { MODEL_REGISTRY, type ConversationModel } from "@plugins/conversations/plugins/model-provider/core";
// ...
const cliFlag = opts?.model ? MODEL_REGISTRY[opts.model].cliFlag : undefined;
```

**After:**
```ts
import { resolveCliFlag } from "@plugins/conversations/plugins/model-provider/server";
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/core";
// ...
const cliFlag = opts?.model ? resolveCliFlag(opts.model) : undefined;
```

### What stays unchanged

- `core/registry.ts` — `MODEL_REGISTRY` stays as-is. Web consumers only read `label`/`iconSize` from it. The `cliFlag` field becomes vestigial on the server path but harmless to keep.
- `infra/plugins/claude-cli/server/internal/run-claude-print.ts` — the `--print` model map is independent.

## Files

| Action | Path |
|--------|------|
| Create | `plugins/conversations/plugins/model-provider/shared/config.ts` |
| Create | `plugins/conversations/plugins/model-provider/server/internal/resolve-cli-flag.ts` |
| Modify | `plugins/conversations/plugins/model-provider/server/index.ts` |
| Modify | `plugins/conversations/plugins/model-provider/web/index.ts` |
| Modify | `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts` |

## Verification

1. `./equin build` — builds, generates config origin file, restarts server
2. Open Settings UI → confirm "Opus version" radio appears under Model Provider
3. Switch to 4.7, launch an Opus conversation → check tmux pane shows `--model claude-opus-4-7`
4. Switch back to 4.6, launch → confirm `--model claude-opus-4-6`
