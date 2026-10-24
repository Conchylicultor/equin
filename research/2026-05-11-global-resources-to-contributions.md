# Migrate `resources` to server contributions

## Context

The server-side contributions primitive was added in `2e8f4628` and the config plugin was migrated to use it. The `resources` field on `ServerPluginDefinition` is the next candidate: it's a decorative array that the bootstrap never iterates — `defineResource()` self-registers into a module-level `Map` as a side effect of import. The field exists only for documentation intent and TypeScript readability.

Migrating to contributions:
- Removes `ResourceLike` and `resources` from `ServerPluginDefinition`, cleaning core of a plugin concern
- Associates each resource with its owning plugin (via `_pluginId` injected by the framework) — currently the resource registry has no concept of ownership
- Follows the precedent set by the config migration

## Design

### Contribution token

Define `Resource.Declare` alongside `defineResource` in `server/src/resources.ts`:

```typescript
import { defineServerContribution } from "./contributions";

export const Resource = {
  Declare: defineServerContribution<{ key: string; mode: ResourceMode }>(
    "resource.declare",
  ),
};
```

Plugins contribute via:

```typescript
import { Resource } from "@server/resources";

contributions: [Resource.Declare(myResource)]
```

This works because every `Resource<T, P>` object returned by `defineResource` has `{ key: string; mode: ResourceMode }`, satisfying the contribution type. Extra fields (`schema`, `load`, `notify`) are spread at runtime but not exposed in the type — harmless and consistent with how contributions work.

### Consumer: debug endpoint

The `_debug` handler in `resources.ts` (`handleResourcesDebug`) currently lists resources with no ownership info. After migration, enrich it by cross-referencing `Resource.Declare.getContributions()` to add `pluginId` and `pluginName` per resource entry.

### Type cleanup

In `server/src/types.ts`:
- Remove `ResourceLike` type (`line 21`)
- Remove `resources?: ResourceLike[]` field from `ServerPluginDefinition` (`lines 51–52`)

### Per-plugin migration

30 server plugin barrels currently declare `resources: [...]`. Each one:

1. Add `import { Resource } from "@server/resources"` (most already import from `@server/resources` for their `defineResource` calls — but the barrel files import the resource objects from `./internal/...`, so this is a new import for the barrel)
2. Replace `resources: [x, y]` with entries in `contributions: [Resource.Declare(x), Resource.Declare(y)]` — merging with any existing `contributions` array
3. Remove the `resources` line

**Plugins with existing `contributions` arrays** (those already contributing `Config.Field`): merge the `Resource.Declare(...)` entries into the same array.

**`plugins/tasks/server/index.ts`** has `resources: []` (empty) — just delete the line, no contribution needed.

### Central runtime — out of scope

`central/src/types.ts` has `resources?: ResourceLike[]` on `CentralPluginDefinition`. Only 1 central plugin uses it (`plugins/auth/central/index.ts`). Central has no contributions primitive. Defer to a future PR when central gets contributions.

## Files to modify

### Core

| File | Change |
|---|---|
| `server/src/resources.ts` | Add `Resource.Declare` token export; enhance `handleResourcesDebug` with ownership info |
| `server/src/types.ts` | Remove `ResourceLike` type and `resources` field |

### Plugin barrels (30 files)

Each `server/index.ts` barrel: replace `resources: [...]` with `contributions: [Resource.Declare(...)]`.

| Plugin barrel | Resources | Has existing `contributions`? |
|---|---|---|
| `plugins/active-data/server/index.ts` | `activeDataBindingsResource` | no |
| `plugins/agents/server/index.ts` | `agentsResource`, `agentLaunchesResource` | no |
| `plugins/agents/plugins/auto-launch/plugins/toggle/server/index.ts` | `agentAutoLaunchResource` | no |
| `plugins/apps/plugins/deploy/plugins/servers/server/index.ts` | `serversResource` | no |
| `plugins/build/server/index.ts` | `mainAheadCountResource`, `buildHistoryResource` | yes (`Config.Field`) |
| `plugins/config/server/index.ts` | `configResource`, `configSecretsResource` | no |
| `plugins/conversations/server/index.ts` | `forkErrorsResource` | no |
| `plugins/conversations/plugins/conversation-category/server/index.ts` | `conversationCategoriesResource`, `categoryColorsResource` | yes (`Config.Field`) |
| `plugins/conversations/plugins/conversation-progress/server/index.ts` | `conversationProgressResource` | no |
| `plugins/conversations/plugins/conversation-view/plugins/code/server/index.ts` | `editedFilesResource` | no |
| `plugins/conversations/plugins/conversation-view/plugins/commits-graph/server/index.ts` | `commitDeltaResource`, `commitsGraphResource` | no |
| `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/index.ts` | `jsonlEventsResource` | no |
| `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/server/index.ts` | `launchPromptsServerResource` | no |
| `plugins/conversations/plugins/conversation-view/plugins/notes/server/index.ts` | `conversationNotesResource` | no |
| `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/server/index.ts` | `promptTemplatesServerResource` | no |
| `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/index.ts` | `pushAndExitResource` | no |
| `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/server/index.ts` | `quickPromptsServerResource` | no |
| `plugins/conversations/plugins/conversation-view/plugins/turn-summary/server/index.ts` | `turnSummariesResource` | yes (`Config.Field`) |
| `plugins/conversations/plugins/conversations-view/plugins/grouped/server/index.ts` | `conversationGroupsResource` | no |
| `plugins/conversations/plugins/conversations-view/plugins/queue/server/index.ts` | `queueRanksResource` | no |
| `plugins/conversations/plugins/summary/server/index.ts` | `conversationSummariesResource` | no |
| `plugins/crashes/server/index.ts` | `crashesResource` | no |
| `plugins/infra/plugins/claude-cli/server/index.ts` | `claudeCliCallsResource` | no |
| `plugins/infra/plugins/git-watcher/server/index.ts` | `refHeadResource` | no |
| `plugins/notifications/server/index.ts` | `notificationsResource` | no |
| `plugins/reorder/server/index.ts` | `reorderPrefsResource` | no |
| `plugins/stats/plugins/commits/server/index.ts` | `excludedPathStateResource` | yes (`Config.Field`) |
| `plugins/tasks-core/server/index.ts` | `tasksResource`, `attemptsResource`, `pushesResource`, `recentConversationsResource` | no |
| `plugins/tasks/plugins/auto-start/server/index.ts` | `tasksAutoStartResource` | no |
| `plugins/tasks/server/index.ts` | `[]` (empty — just delete) | no |

### Docs generation

`plugins/plugin-meta/plugins/plugin-tree/shared/internal/plugin-tree.ts` — `parseResources()` scans for `defineResource(` calls via regex, **not** the `resources` field. No change needed. The static analysis is decoupled from the type.

## Verification

1. `./equin build` — confirms server compiles and starts
2. `curl http://<worktree>.localhost:9000/api/resources/_debug` — verify all resources appear in the debug endpoint, now with `pluginId`/`pluginName` attached
3. `./equin check` — passes (including `plugins-doc-in-sync` since `parseResources` is unchanged)
4. Spot-check a push resource (e.g. tasks) and an invalidate resource (e.g. config) still sync correctly in the browser
