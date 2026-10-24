# Reusable folder-picker config field type

## Context

Sonata's MIDI watched-folder config (`midi-folders` config_v2 listField) asks the user to
hand-type an absolute folder path into a free-text `textField`. There is no way to browse the
host filesystem, navigate into directories, pick one, or see whether the path actually exists.
It's error-prone and unfriendly.

This is a general need, not a Sonata one-off: any config that wants a directory should get a real
picker for free. So we add a **reusable folder-picker** as:

1. a new `primitives/folder-picker` plugin (the host-FS browse endpoint + the picker UI widget), and
2. a new `directory-path` **field type** (identity + config renderer) that wraps the widget,

then swap Sonata's `textField` → `dirPathField`. The watcher consumes `f.path` strings and is
field-type-agnostic, so no server-side Sonata change is needed.

Decisions confirmed with the user:
- **Home:** one cohesive `primitives/folder-picker` plugin owns its full stack (core endpoint def
  + server FS handler + web hook & widget), mirroring how `color-picker`/`icon-picker` own theirs.
  (Novel only in that a `primitives/` plugin hosts an `httpRoutes` route — allowed; `ServerPluginDefinition`
  supports `httpRoutes` regardless of directory.)
- **UX:** typeable/pasteable path input **plus** a Browse popover (breadcrumb + clickable subdirs +
  "Select this folder") and a live green-check / red-X validity indicator.
- **Validation:** schema stays `z.string()` (no hard gate); existence/is-directory is shown live via
  the endpoint; the server rejects only relative paths at browse time.

## Verified facts (load-bearing)

- Endpoint registration: `httpRoutes: { [def.route]: handler }` in a `ServerPluginDefinition`; handler
  built with `implement(def, async ({ params, query }) => …)`. Confirmed in
  `plugins/debug/plugins/memory/server/index.ts`.
- `implement()` converts a thrown `HttpError(status, msg)` into the right HTTP response; any other
  throw propagates (fail loudly). `query` is auto-parsed/validated from the route's `querySchema`.
  `HttpError` is exported from `@plugins/infra/plugins/endpoints/server`.
- Client: `useEndpoint(def, params, { query, enabled })` — TanStack Query wrapper. params `{}` when
  there are no route params; the typed value goes in `query`.
- `InlinePopover` (`@plugins/primitives/plugins/popover/web`) and `FilepathBreadcrumb`
  (`@plugins/primitives/plugins/filepath-breadcrumb/web`, has copy + directory-nav) both exist.
- A field TYPE = `plugins/fields/plugins/<type>/` (identity, contributes `Fields.Identity` from
  `@plugins/fields/web`) + nested `plugins/config/` (factory in `core` + renderer in `web` contributing
  `Fields.Renderer` from `@plugins/config_v2/plugins/fields/web`). Renderer must set static `.type`.
  Mirror `text` (input) and `color` (wraps a picker primitive; `ColorFieldDef extends FieldDef`).

## Plan

### 1. New plugin: `plugins/primitives/plugins/folder-picker/`

`package.json` — name `@singularity/plugin-primitives-folder-picker`. Match `color-picker`/`icon-picker`
siblings: **no** `"singularity": { "collapsed": true }` (leaf primitive, shown in the tree).

**`core/index.ts`** — the browse endpoint contract (browser-safe, imported by server + web):

```ts
import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

const DirEntrySchema = z.object({ name: z.string(), isDirectory: z.boolean() });

/**
 * Browse a host directory. No `path` → user's home dir (natural start). Returns the resolved
 * absolute path, its parent (null at FS root), whether it exists and is a directory (drives the
 * validity indicator), and its immediate sub-entries (directories first) for drill-down.
 */
export const browseHostDir = defineEndpoint({
  route: "GET /api/primitives/folder-picker/browse",
  query: z.object({ path: z.string().optional() }),
  response: z.object({
    path: z.string(),
    parent: z.string().nullable(),
    exists: z.boolean(),
    isDirectory: z.boolean(),
    entries: z.array(DirEntrySchema),
  }),
});
```

**`server/internal/browse.ts`** — `implement(browseHostDir, …)`. Logic:
- `target = query.path?.trim() || homedir()`; if `!isAbsolute(target)` → `throw new HttpError(400, …)`.
- `path = resolve(target)`; `parent = dirname(path) === path ? null : dirname(path)`.
- `stat(path)`: `ENOENT` → return `{ path, parent, exists: false, isDirectory: false, entries: [] }`
  (a missing typed path is a legitimate red-X result, **not** an error); `EACCES`/`EPERM` →
  `throw new HttpError(403, …)`; anything else → rethrow (fail loudly).
- not a directory → `{ exists: true, isDirectory: false, entries: [] }`.
- `readdir(path, { withFileTypes: true })` (same `EACCES`/`EPERM` → 403, else rethrow); map to
  `{ name, isDirectory }`, sort directories-first then `localeCompare`. Return with `entries`.

Imports: `node:fs/promises` (`readdir`, `stat`), `node:os` (`homedir`), `node:path`
(`dirname`, `isAbsolute`, `resolve`), `implement`/`HttpError` from `@plugins/infra/plugins/endpoints/server`.

**`server/index.ts`**:
```ts
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { browse } from "./internal/browse";
import { browseHostDir } from "../core";

export default {
  description:
    "Host filesystem directory-browsing endpoint backing the folder-picker UI: lists a directory's subdirectories and validates a typed path.",
  httpRoutes: { [browseHostDir.route]: browse },
} satisfies ServerPluginDefinition;
```

**`web/internal/use-host-dir.ts`** — `useHostDir(path, opts?)` thin `useEndpoint(browseHostDir, {}, { query: { path }, enabled })` wrapper.

**`web/internal/folder-picker.tsx`** — `FolderPicker` browser block (used inside the popover):
- Local `browsePath` state (starts at committed `value` or `undefined` → home).
- `const { data, isLoading } = useHostDir(browsePath)`.
- `FilepathBreadcrumb` of `data.path` with `onNavigate(ancestor) => setBrowsePath(ancestor)`.
- Each `data.entries` (directories) rendered as a `Row` (`@plugins/primitives/plugins/row/web`);
  click → `setBrowsePath(`${data.path}/${name}`)` (server `resolve()` normalizes).
- `Spinner` while loading; `Placeholder` for empty dir / "not a directory".
- "Select this folder" action → `onChange(data.path)` and close.

**`web/internal/folder-picker-popover.tsx`** — `FolderPickerPopover({ value, onChange, placeholder })`:
- shadcn `<Input>` (`@/components/ui/input`) — typeable/pasteable, commit on blur (mirror `TextRenderer`'s
  `useLocalValue` + commit-if-changed).
- Live validity indicator: `useHostDir(value, { enabled: !!value })` → green `MdCheckCircle` if
  `data.exists && data.isDirectory`, red `MdCancel` otherwise (icons from `react-icons/md`).
- Browse `IconButton` (`@plugins/primitives/plugins/icon-button/web`, `MdFolderOpen`) toggling an
  `InlinePopover` (`@plugins/primitives/plugins/popover/web`) that wraps `FolderPicker`.

**`web/index.ts`** — barrel: re-export `FolderPickerPopover`, `FolderPicker`, `useHostDir` and their
prop types; `contributions: []`.

**`CLAUDE.md`** — short prose (build augments the autogen reference block).

### 2. New plugin: `plugins/fields/plugins/directory-path/` (identity)

`package.json` — `@singularity/plugin-fields-directory-path`, `"singularity": { "collapsed": true }`
(match `text`/`color` field packages).

- `core/internal/directory-path.ts`:
  ```ts
  export const directoryPathFieldType = defineFieldType<string>("directory-path");
  export const directoryPathIdentity = defineFieldIdentity<string>({
    type: directoryPathFieldType,
    label: "Folder",
    icon: MdFolder, // react-icons/md
    coerce: (v) => (typeof v === "string" ? v : String(v ?? "")), // identical to text; pure/total
  });
  ```
- `core/index.ts` — re-export both.
- `web/index.ts` — `contributions: [Fields.Identity({ identity: directoryPathIdentity })]`
  (`Fields` from `@plugins/fields/web`).
- `CLAUDE.md`.

### 3. New plugin: `plugins/fields/plugins/directory-path/plugins/config/` (config renderer)

`package.json` — `@singularity/plugin-fields-directory-path-config`, `collapsed: true`.

- `core/internal/directory-path.ts`:
  ```ts
  export interface DirPathFieldDef extends FieldDef<string> {
    readonly type: typeof directoryPathFieldType;
  }
  export function dirPathField(opts?: FieldMeta & { default?: string }): DirPathFieldDef {
    return Object.freeze({
      type: directoryPathFieldType,
      schema: z.string(),
      defaultValue: opts?.default ?? "",
      meta: pickMeta(opts), // pickMeta, FieldMeta from @plugins/config_v2/core
    });
  }
  ```
- `core/index.ts` — re-export `dirPathField`, `DirPathFieldDef`.
- `web/components/dir-path-renderer.tsx`:
  ```tsx
  const DirPathRenderer: FieldRendererComponent<string> = ({ field, value, onChange }) => (
    <div className="flex flex-col gap-1.5 py-3">
      <FieldHeader field={field} />
      <FolderPickerPopover value={value} onChange={onChange} placeholder={field.meta.placeholder} />
    </div>
  );
  DirPathRenderer.type = directoryPathFieldType;
  ```
  (`FieldHeader`, `FieldRendererComponent` from `@plugins/config_v2/plugins/fields/web`;
  `FolderPickerPopover` from `@plugins/primitives/plugins/folder-picker/web`. Check how it sits inside
  the `listField` row and match the `text` field's layout there — drop `FieldHeader` if the list already
  labels rows.)
- `web/index.ts` — `contributions: [Fields.Renderer(DirPathRenderer)]`
  (`Fields` from `@plugins/config_v2/plugins/fields/web`).
- `CLAUDE.md`.

### 4. Swap Sonata's field

`plugins/apps/plugins/sonata/plugins/sources/plugins/midi/plugins/folders/shared/config.ts`:
- import `dirPathField` from `@plugins/fields/plugins/directory-path/plugins/config/core` (drop `textField`).
- `path: textField({ label: "Absolute folder path" })` → `path: dirPathField({ label: "Absolute folder path" })`.
No server change (`watchedDirs()`/`watcher.ts` consume `f.path` strings).

### 5. Build & codegen

Run `./equin build` — autogenerates the plugin registry and the `fields.identity` /
`config-v2.fields.renderer` slot wiring from the filesystem. The `midi-folders` config origin's schema
fingerprint changes (field type `text`→`directory-path`); if any `midi-folders.jsonc` override exists in
`config/` or `~/.singularity/config/`, update its `// @hash` per the conflict-reconciliation rules
(low-risk: default is an empty list, so an override is unlikely to exist).

## Files

Create:
- `plugins/primitives/plugins/folder-picker/{package.json,CLAUDE.md}`
- `plugins/primitives/plugins/folder-picker/core/index.ts`
- `plugins/primitives/plugins/folder-picker/server/{index.ts,internal/browse.ts}`
- `plugins/primitives/plugins/folder-picker/web/{index.ts,internal/use-host-dir.ts,internal/folder-picker.tsx,internal/folder-picker-popover.tsx}`
- `plugins/fields/plugins/directory-path/{package.json,CLAUDE.md,core/index.ts,core/internal/directory-path.ts,web/index.ts}`
- `plugins/fields/plugins/directory-path/plugins/config/{package.json,CLAUDE.md,core/index.ts,core/internal/directory-path.ts,web/index.ts,web/components/dir-path-renderer.tsx}`

Modify:
- `plugins/apps/plugins/sonata/plugins/sources/plugins/midi/plugins/folders/shared/config.ts` (one-line field swap)

## Risks / notes

- **Host-FS exposure (new surface).** No existing endpoint lists arbitrary host directories; this one
  does. Mitigation: it returns only `{ name, isDirectory }` — never file contents; no sandbox root (the
  whole point is to browse the host to pick any folder); `EACCES`/`EPERM` surface as 403 so the endpoint
  can never read a dir the server process itself can't. Acceptable for a local-first per-user tool (the
  file-explorer app + terminal already grant more). Flag in the PR for review.
- **Coerce stays pure** — identical to text's; no normalization in `coerce` (it runs in data-view
  contexts and must be total). Normalization lives server-side (`resolve`) and at the renderer's commit.
- **Schema stays `z.string()`** — a `.isAbsolute`/exists refine would break config_v2's
  `.default("")` backfill and reject in-progress empty list rows; validity is advisory UI only.

## Verification

1. `./equin build` — succeeds; registry regenerated. `./equin check` passes
   (`plugin-boundaries`, `plugins-doc-in-sync`, `migrations-in-sync`, `eslint`).
2. Open `http://<worktree>.localhost:9000`, go to Sonata's settings → "Watched MIDI folders". Add a row:
   - the field shows a path input + Browse button;
   - Browse opens a popover that lists the home dir's subfolders, breadcrumb navigates up, clicking a
     subfolder drills in, "Select this folder" fills the path and closes;
   - typing a real dir shows a green check; typing a bogus path shows a red X.
   Scripted check (state + before/after): `bun e2e/screenshot.mjs --url <sonata settings> --click "Browse" --out /tmp/folder-picker`.
3. Endpoint sanity (server up): `GET /api/primitives/folder-picker/browse` (no path → home listing);
   `?path=/nonexistent` → `exists:false`; `?path=relative` → 400.
4. Confirm the chosen path persists and Sonata's watcher picks up `.mid` files dropped into it
   (`query_db` the sonata tables / check logs), proving the string value flows through unchanged.
