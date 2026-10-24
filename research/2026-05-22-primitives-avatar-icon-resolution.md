# Avatar Icon Resolution — Server-Side Static Map

## Context

Avatar configs currently store redundant SVG path data alongside the icon key:
```json
{ "icon": "question_mark", "color": "sky", "svgNodes": [{ "tag": "path", "attr": { "d": "M11.07..." }, "child": [] }] }
```

The `svgNodes` field exists solely to avoid loading all 2160 Material Design icons at render time. But storing it in config is wasteful — it bloats JSONC files, makes config diffs noisy, and duplicates data that's derivable from the icon key.

**Goal:** Config stores only `{ "icon": "question_mark", "color": "sky" }`. The server resolves `svgNodes` transparently before serving to clients using a pre-generated static map.

## Approach

Resolution lives **inside the Zod schema** (`.transform()`) with a pluggable resolver registered at server startup. No new contribution types or hook primitives — just a module-level registry map in `config_v2/core`.

### Data Flow

```
Config JSONC:  { icon: "star", color: "amber" }
       ↓ readTypedConfig → schema.safeParse()
       ↓ avatar schema .transform() calls getFieldResolver("avatar")
       ↓ resolver looks up ICON_SVG_MAP["star"] → SvgNode[]
Server cache:  { icon: "star", color: "amber", svgNodes: [...] }
       ↓ live-state resource push
Web client:    receives fully-resolved AvatarSpec, renders directly
```

### Write Path

AvatarRenderer strips `svgNodes` before calling onChange, so only `{ icon, color, svgNodes: null }` is written to JSONC. On next read, the transform fills it back in.

## Implementation Steps

### 1. Static icon map (generated once, committed)

**New file:** `plugins/primitives/plugins/avatar/server/internal/icon-svg-map.generated.ts`

A `Record<string, SvgNode[]>` covering all ~2160 icons + curated aliases. ~650KB, server-only (never in web bundle).

**Generator script:** `plugins/primitives/plugins/avatar/server/internal/gen-icon-svg-map.ts`

```ts
// Reads icon-metadata.json keys
// Imports react-icons/md
// Extracts SvgNode[] for each icon (reuses existing extractChildren logic)
// Includes CURATED_ALIASES as additional keys
// Writes the generated file with header comment + inputs-hash
```

Run manually: `bun run plugins/primitives/plugins/avatar/server/internal/gen-icon-svg-map.ts`

Regenerate only when `react-icons` version changes or `icon-metadata.json` is updated. NOT part of `./equin build`.

### 2. Field resolver registry in config_v2/core

**New file:** `plugins/config_v2/core/internal/field-resolvers.ts`

```ts
type FieldResolver = (val: unknown) => unknown;
const _registry = new Map<string, FieldResolver>();

export function registerFieldResolver(typeId: string, fn: FieldResolver): void {
  _registry.set(typeId, fn);
}

export function getFieldResolver(typeId: string): FieldResolver | undefined {
  return _registry.get(typeId);
}
```

**Update:** `plugins/config_v2/core/index.ts` — export both functions.

This is a plain module-level Map. Resolvers are registered at module load time (top-level side effects in server barrels), which executes before any `onReady` is called — guaranteed by the framework's plugin loading order.

### 3. Avatar Zod schema: make svgNodes optional + add transform

**File:** `plugins/config_v2/plugins/fields/plugins/avatar/core/internal/avatar.ts`

```ts
import { getFieldResolver } from "@plugins/config_v2/core";

const avatarSpecSchema = z.object({
  icon: z.string().nullable(),
  color: z.string().nullable(),
  svgNodes: z.array(svgNodeSchema).nullable().optional(),
}).transform((val): AvatarSpec => {
  const resolver = getFieldResolver("avatar");
  if (resolver) return resolver(val) as AvatarSpec;
  return { icon: val.icon, color: val.color, svgNodes: val.svgNodes ?? null };
});
```

The transform produces `ZodEffects<...>` which satisfies `FieldDef.schema: z.ZodType<T>`. No type signature changes needed elsewhere. The list field's `subShape[key] = field.schema` correctly propagates the transform through nested items.

### 4. Register resolver in avatar server barrel

**File:** `plugins/primitives/plugins/avatar/server/index.ts`

```ts
import { registerFieldResolver } from "@plugins/config_v2/core";
import { ICON_SVG_MAP } from "./internal/icon-svg-map.generated";

registerFieldResolver("avatar", (val) => {
  const spec = val as { icon: string | null; color: string | null; svgNodes?: SvgNode[] | null };
  if (spec.svgNodes != null && spec.svgNodes.length > 0) return spec;
  return { ...spec, svgNodes: spec.icon ? (ICON_SVG_MAP[spec.icon] ?? null) : null };
});
```

Module-level — executes when the plugin module is loaded, before config_v2's `onReady`.

### 5. Simplify resolve-svg.ts

**File:** `plugins/primitives/plugins/avatar/server/internal/resolve-svg.ts`

Replace the async dynamic-import version with a sync lookup:

```ts
import { ICON_SVG_MAP } from "./icon-svg-map.generated";

export function resolveIconSvgNodes(iconKey: string): SvgNode[] | null {
  return ICON_SVG_MAP[iconKey] ?? null;
}

export async function resolveIconSvgNodesJson(iconKey: string): Promise<string | null> {
  const nodes = resolveIconSvgNodes(iconKey);
  return nodes ? JSON.stringify(nodes) : null;
}
```

Preserves the async signature for backward compatibility (agents backfill uses it), but internally delegates to the sync version.

### 6. Strip svgNodes on write (AvatarRenderer)

**File:** `plugins/config_v2/plugins/fields/plugins/avatar/web/components/avatar-renderer.tsx`

```tsx
<AvatarPicker
  value={value}
  onChange={(next) => onChange({ icon: next.icon, color: next.color, svgNodes: null })}
>
```

This ensures written JSONC contains `"svgNodes": null` rather than the full path data. The transform fills it on next read.

### 7. Clean up config files

**File:** `config/conversations/conversation-category/config.jsonc`

Strip `svgNodes` from all 8 category entries:
```json
{ "name": "General question", "avatar": { "icon": "question_mark", "color": "sky" } }
```

Update `// @hash` on line 1 to match (run build to recompute).

### 8. Add icon-svg-in-sync check

**New plugin:** `plugins/primitives/plugins/avatar/check/index.ts`

Verifies the generated map matches current inputs. Strategy: embed an `@inputs-hash` in the generated file (hash of `icon-metadata.json` content + `react-icons` package version). The check recomputes the hash and compares.

```ts
export default {
  id: "icon-svg-map-in-sync",
  description: "icon-svg-map.generated.ts matches current react-icons/md + icon-metadata.json",
  async run() { /* recompute inputs-hash, compare to file header */ }
};
```

## Critical Files

| File | Action |
|------|--------|
| `plugins/config_v2/core/internal/field-resolvers.ts` | CREATE — registry |
| `plugins/config_v2/core/index.ts` | UPDATE — export registry |
| `plugins/config_v2/plugins/fields/plugins/avatar/core/internal/avatar.ts` | UPDATE — optional svgNodes + transform |
| `plugins/config_v2/plugins/fields/plugins/avatar/web/components/avatar-renderer.tsx` | UPDATE — strip svgNodes on write |
| `plugins/primitives/plugins/avatar/server/internal/icon-svg-map.generated.ts` | CREATE — static map |
| `plugins/primitives/plugins/avatar/server/internal/gen-icon-svg-map.ts` | CREATE — generator script |
| `plugins/primitives/plugins/avatar/server/internal/resolve-svg.ts` | UPDATE — sync version using map |
| `plugins/primitives/plugins/avatar/server/index.ts` | UPDATE — register resolver + export sync |
| `plugins/primitives/plugins/avatar/check/index.ts` | CREATE — in-sync check |
| `config/conversations/conversation-category/config.jsonc` | UPDATE — strip svgNodes |

## Notes

- **DEFAULT_AGENT_AVATAR** in `plugins/primitives/plugins/avatar/web/internal/icons.ts` — this is a web-side fallback for the agents DB flow (separate from config_v2). Keep its inlined svgNodes for now; it's a separate concern.
- **Agents DB column** (`icon_svg_nodes`) — the agents plugin's `iconSvgNodes` column and backfill job remain unchanged. They serve a different path (DB → web, not config → web).
- **Bundle impact** — zero. The ~650KB map lives only in the server module graph. Web bundle unchanged.

## Verification

1. `./equin build` — TypeScript compiles, no check failures
2. Open Settings → Conversation categories: avatars render correctly
3. Pick a new avatar, save → verify JSONC file has no `svgNodes` path data
4. Restart server → avatars still render (resolved from map on read)
5. `./equin check --icon-svg-map-in-sync` passes
