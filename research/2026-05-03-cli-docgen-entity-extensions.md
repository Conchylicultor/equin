# Docgen: auto-document entity-extensions consumers

## Context

`entity-extensions` is the primitive that lets sub-plugins attach typed DB fields to a parent entity table via a 1:1 side-table (e.g. `conversations_ext_queue`, `agents_ext_auto_launch`). Currently the docgen system treats those side-table declarations as ordinary DB schema files — it emits a generic `- DB schema: plugins/.../tables.ts` line with no semantic meaning. The parent plugin has no documentation that anything extends its tables.

There are already three consumers today:

| Plugin | Call | Side-table |
|---|---|---|
| `conversation-category` | `defineExtension(_conversations, "category", …)` | `conversations_ext_category` |
| `toggle` (agents/auto-launch) | `defineExtension(_agents, "auto_launch", …)` | `agents_ext_auto_launch` |
| `queue` (conversations-view) | `defineExtension(_conversations, "queue", …)` | `conversations_ext_queue` |

Without semantic doc support, agents can't tell at a glance that a plugin extends another plugin's entity, or that a plugin's table is extended.

## Target output

After this change, `plugins-details.md` (and each plugin's `CLAUDE.md`) will include:

**Consuming plugin** (`queue`) — inside `Defines:` section:
```
- Defines:
    - DB schema: `plugins/.../tables.ts`
    - Entity extension of: `tasks-core` (table `conversations_ext_queue`)
```

**Parent plugin** (`tasks-core`) — new reverse-index line alongside `Imported by:`, etc.:
```
- Extended by: `queue` (table `conversations_ext_queue`), `conversation-category` (table `conversations_ext_category`)
```

## Implementation — single file: `cli/src/docgen.ts`

### 1. New interfaces (add after `BarrelExport`)

```ts
interface EntityExtension {
  parentPlugin: string;  // e.g. "tasks-core"
  extName: string;       // e.g. "queue"
  tableName: string;     // e.g. "conversations_ext_queue"
}

interface EntityExtensionRef {
  childPlugin: string;
  extName: string;
  tableName: string;
}
```

### 2. Two new fields on `PluginInfo`

```ts
entityExtensions: EntityExtension[];   // this plugin defines a side-table on another plugin's entity
extendedBy: EntityExtensionRef[];      // other plugins have added side-tables to this plugin's entity
```

Initialize both to `[]` at the end of `collectPlugin`.

### 3. Two new pure helper functions (add near `findDbFiles`)

**`parseEntityExtensionCalls`** — scans a plugin's DB files for `defineExtension(var, "name", …)` calls and returns raw refs:

```ts
interface RawExtRef { parentVarName: string; parentModule: string; extName: string; }

function parseEntityExtensionCalls(dbFiles: string[]): RawExtRef[] {
  const out: RawExtRef[] = [];
  for (const f of dbFiles) {
    const raw = readIfExists(f);
    if (!raw || !raw.includes("defineExtension")) continue;
    const src = stripTypes(raw);
    const imports = parseImports(src);
    const re = /\bdefineExtension\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const imp = imports.get(m[1]!);
      if (!imp) continue;
      out.push({ parentVarName: imp.original, parentModule: imp.module, extName: m[2]! });
    }
  }
  return out;
}
```

Key points:
- Uses `imp.original` (not `imp.local`) so aliased imports like `import { _agents as a }` still resolve correctly.
- Checks `raw.includes("defineExtension")` as a fast-skip before parsing.

**`parseTableNamesFromDbFiles`** — scans a plugin's DB files for `pgTable("name", …)` and maps exported var name → drizzle table name:

```ts
function parseTableNamesFromDbFiles(dbFiles: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of dbFiles) {
    const raw = readIfExists(f);
    if (!raw) continue;
    const src = stripTypes(raw);
    const re = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*pgTable\s*\(\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.set(m[1]!, m[2]!);
  }
  return out;
}
```

### 4. Extend `computeReverseIndexes` — new section 4

Add after the existing three sections (importedBy, slotContributors, endpointCallers):

```ts
// 4. entityExtensions — detect defineExtension() calls; cross-link to parent plugin
const pluginVarToTable = new Map<string, Map<string, string>>();
for (const info of byDir.values()) {
  pluginVarToTable.set(info.name, parseTableNamesFromDbFiles(info.dbFiles));
}

const pluginModuleRe = /@plugins\/([^/"'`]+)\/(?:server|central|shared)/;
for (const info of byDir.values()) {
  for (const ref of parseEntityExtensionCalls(info.dbFiles)) {
    const pluginMatch = ref.parentModule.match(pluginModuleRe);
    if (!pluginMatch) continue;
    const parentPluginName = pluginMatch[1]!;
    const parentTableName = (pluginVarToTable.get(parentPluginName) ?? new Map()).get(ref.parentVarName) ?? "";
    const tableName = parentTableName
      ? `${parentTableName}_ext_${ref.extName}`
      : `${parentPluginName}_ext_${ref.extName}`;   // fallback if table name unresolvable
    if (!info.entityExtensions.some((e) => e.tableName === tableName)) {
      info.entityExtensions.push({ parentPlugin: parentPluginName, extName: ref.extName, tableName });
    }
    const parentPlugin = byName.get(parentPluginName);
    if (parentPlugin && !parentPlugin.extendedBy.some((e) => e.tableName === tableName)) {
      parentPlugin.extendedBy.push({ childPlugin: info.name, extName: ref.extName, tableName });
    }
  }
}
for (const info of byDir.values()) {
  info.entityExtensions.sort((a, b) => a.tableName.localeCompare(b.tableName));
  info.extendedBy.sort((a, b) => a.tableName.localeCompare(b.tableName));
}
```

The `pluginModuleRe` regex matches `@plugins/<name>/{server,central,shared}` and extracts the top-level plugin name, consistent with the existing `modRe` pattern used in `parseServerApiUses`.

### 5. Update `renderPluginBody`

**In the `Defines:` section** (inside `for (const f of p.dbFiles)` block's sibling, after the dbFiles loop):

```ts
for (const ext of p.entityExtensions) {
  defines.push(
    `${subIndent}- Entity extension of: \`${ext.parentPlugin}\` (table \`${ext.tableName}\`)`,
  );
}
```

**In the reverse indexes** (after `endpointCallers`):

```ts
if (p.extendedBy.length > 0) {
  lines.push(
    `${bodyIndent}- Extended by: ${p.extendedBy.map((e) => `\`${e.childPlugin}\` (table \`${e.tableName}\`)`).join(", ")}`,
  );
}
```

## Files to modify

- `cli/src/docgen.ts` — the only file

## Verification

1. Run `./equin build` — this triggers docgen as part of the build
2. Inspect `docs/plugins-details.md`:
   - `tasks-core` entry should have `Extended by: \`conversation-category\` (table \`conversations_ext_category\`), \`queue\` (table \`conversations_ext_queue\``
   - `agents` entry should have `Extended by: \`toggle\` (table \`agents_ext_auto_launch\`)`
   - `queue`, `conversation-category`, `toggle` entries should each have `Entity extension of: ...` inside their `Defines:` section
3. Check `plugins/tasks-core/CLAUDE.md` — `## Plugin reference` block should include the `Extended by:` line
4. Run `./equin check` — verify no check failures
