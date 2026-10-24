# Tauri release: auto-generate the platform icon set from the composition's app icon

## Context

`./equin release --composition <name> --target tauri` should produce a desktop
app end-to-end with a **single command on a clean checkout** — no manual pre-steps.

Today it does not. `tauri/src-tauri/icons/` (the icns/png files referenced by
`tauri/src-tauri/tauri.conf.json` → `bundle.icon`) is **gitignored and absent** on a
fresh checkout, and the release pipeline never generates it. `tauri build` aborts at
its icon-validation step before the app is ever built. The only documented fix
(`tauri/README.md`) is to hand-run `bun x @tauri-apps/cli@2 icon path/to/app-icon.png`
beforehand — a manual step that defeats the one-command goal.

This plan makes the release **derive the icon from the composition's own app icon**
(the serializable `AppIcon` descriptor landed in the recent `app-icon` plugin commit)
and generate the full platform set automatically, so a clean checkout builds with no
manual steps.

## The two problems to solve

1. **Get the composition's app icon at CLI/build time.** The `AppIcon`
   (`{ kind: "md"; svgNodes }`, a 24×24 `currentColor` glyph) is declared **only** in
   each app shell's *web* barrel via `Apps.App({ icon: mdAppIcon(MdPiano) })`. There is
   no server/CLI-side resolution path. (Reading it headlessly via the `barrel-import`
   stub does **not** work — verified: `extractSvgNodes` reads `el.props` off
   `createElement(...)`, and the stub's `createElement` returns `null`, so it throws.)
2. **Rasterize glyph → PNG → platform set.** No SVG→PNG rasterizer exists in the repo.
   `bun x @tauri-apps/cli@2 icon <≥512px.png>` is the canonical generator (it writes the
   whole set — `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico` —
   into the `icons/` dir next to `tauri.conf.json`); we only need to feed it one PNG.

## Approach

Make the per-app icon **resolvable server-side from a plain string key in `core/`**,
build an SVG string from the resolved nodes, rasterize it with `@resvg/resvg-js`
(pure-Wasm, no native deps), and hand the PNG to `tauri icon` inside `wrapTauri` before
either tauri invocation. A `./equin check` guards against the web/core icon
diverging.

### 1. `iconKey` as the server-readable single handle — `core/`

The icon already lives in the web barrel as a react-icons component, which the server
cannot read. Add the icon's MD key as plain core data (CLAUDE.md "closed list → plain
data in core") so both runtimes can resolve it.

- `plugins/primitives/plugins/pane/core/route.ts` — extend `AppRef` + `defineApp`:
  ```ts
  export interface AppRef { readonly id: string; readonly basePath: string; readonly iconKey: string; }
  export function defineApp(def: { id: string; basePath: string; iconKey: string }): AppRef { ... }
  ```
- Each app shell core (≈13 call sites, e.g.
  `plugins/apps/plugins/sonata/plugins/shell/core/app.ts`):
  ```ts
  export const sonataApp = defineApp({ id: "sonata", basePath: "/sonata", iconKey: "piano" });
  ```
  (Making `iconKey` required surfaces every app that hasn't declared one as a type error
  — every app becomes releasable by construction.)

The web `Apps.App` contributions keep using `mdAppIcon(MdPiano)` unchanged (the web has
no synchronous key→nodes resolver — only `extractSvgNodes(Component)` and async
`loadFullIconSet()`), so we do **not** rewire web rendering here.

**Drift guard** — a new `plugins/apps-core/plugins/app-icon/check/index.ts`
(`app-icon:key-in-sync`) static-parses, per app shell, the `MdXxx` token in
`mdAppIcon(MdXxx)` (web) → derives its key (`MdPiano` → `piano`) and asserts it equals
the core `iconKey`. Pure static parse + no React; fails the build on divergence. This
keeps the two representations honest. *(Follow-up, out of scope: a codegen that makes
web derive its `AppIcon` from `iconKey` too, collapsing to one literal source and
dropping the check — noted, not built here.)*

### 2. Server/core SVG-string serializers

The existing `renderNodes`/`SvgIcon` are React-only. Add plain-string twins:

- `plugins/primitives/plugins/icon-picker/core` — new internal file re-exported from the
  barrel: `svgNodesToString(nodes: SvgNode[]): string` (recursive serialize of
  `{tag, attr, child}` with attribute escaping). icon-picker owns `SvgNode`, so the
  serializer belongs with it; runtime-agnostic, usable by CLI and web.
- `plugins/apps-core/plugins/app-icon/core` — new internal file re-exported from the
  barrel: `appIconToSvg(icon: AppIcon, opts?: AppIconSvgOptions): string`. app-icon owns
  `AppIcon`; the `kind` switch gives the future `{ kind: "image" }` variant a home.
  ```ts
  export interface AppIconSvgOptions {
    size?: number;             // canvas px, default 512 (tauri wants ≥512)
    background?: string | null; // null = transparent
    cornerRadius?: number;     // rounded-rect radius px (ignored when no bg)
    foreground?: string;       // concrete glyph fill (resvg has no "currentColor")
    padding?: number;          // glyph margin as fraction of size, default ~0.18
  }
  ```
  Centering math: glyph viewBox is `0 0 24 24`; on an `S×S` canvas with padding `p`,
  `inner = S*(1-2p)`, `scale = inner/24`, `translate = S*p` (equal x/y → centered):
  ```
  <svg xmlns viewBox="0 0 S S" width=S height=S>
    {background ? <rect width=S height=S rx=cornerRadius fill=background/> : ""}
    <g transform="translate(t,t) scale(s)" fill={foreground}>{svgNodesToString(nodes)}</g>
  </svg>
  ```

**Visual treatment (open knob — set the defaults here).** The descriptor is monochrome
with no color/background. Recommended default: **white glyph on a solid rounded-square
background** (`background` = a single brand/neutral color, `cornerRadius` ≈ `size*0.22`,
`foreground` = `#fff`) — looks like a real desktop icon. Alternatives are one-line
default swaps: dark glyph on white, or `background: null` for a bare transparent glyph.
*(This is the decision flagged for review — the exact default background color is a
single constant in `appIconToSvg`.)*

### 3. Rasterizer — `@resvg/resvg-js`

Add to `plugins/framework/plugins/cli/package.json` dependencies (release-only tool;
keep it out of every other workspace's closure). In `release.ts`:
```ts
import { Resvg } from "@resvg/resvg-js";
function renderPng(svg: string, size = 512): Uint8Array {
  return new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
}
```

### 4. Generate the icon set inside `wrapTauri`

Insert **after the override write (`release.ts:453`) and before the `if (dev)` branch
(`:455`)** so both `tauri dev` and `tauri build` paths get a populated `icons/` dir:

```ts
// ── Generate the platform icon set from the composition's app icon ──────────
const iconKey = resolveCompositionIconKey({ root, composition }); // see below
const svgNodes = resolveIconSvgNodes(iconKey);                    // icon-picker/server
if (!svgNodes) throw new Error(`release: app "${composition}" iconKey "${iconKey}" did not resolve to an icon.`);
const svg = appIconToSvg({ kind: "md", svgNodes });              // app-icon/core
const pngPath = join(tmpdir(), `${composition}-appicon-512.png`);
writeFileSync(pngPath, renderPng(svg, 512));
console.log("\n[tauri] Generating icon set from app icon...");
await run(["bun", "x", "@tauri-apps/cli@2", "icon", pngPath], { cwd: tauriDir });
const iconsDir = join(srcTauri, "icons");
for (const f of ["32x32.png","128x128.png","128x128@2x.png","icon.icns","icon.ico"])
  if (!existsSync(join(iconsDir, f))) throw new Error(`release: tauri icon did not produce ${f}`);
```

`resolveCompositionIconKey({ root, composition })` (new helper in `release.ts`) maps
composition → entry app id → `iconKey`, reusing the composition-closure pattern already
in `build.ts:735-745` (`compositionsConfig.fields.manifests.defaultValue` →
`manifestItemToManifest` → `entryPoints` like `["apps.sonata"]`; for a `category:"app"`
composition the app id is the composition name). It locates the entry app's `core`
node via `buildPluginTree(join(root,"plugins"), { skipBarrelImport: true })` (already
imported in the CLI) and **static-parses** `iconKey` from its `defineApp({...})` — no
execution, no stub, mirroring the facets static-parse approach. Throw loudly if no entry
app or no `iconKey`.

**Always regenerate** (no skip-if-exists): the task's contract is "clean checkout
builds". Generation is deterministic and idempotent (`tauri icon` overwrites in place);
regenerating each release keeps the gitignored dir authoritative and avoids stale icons.
This also fixes the existing macOS dmg step (`packageMacDmg` reads
`icons/icon.icns:522`), which currently relies on the same absent dir.

## Files to change

| File | Change |
|------|--------|
| `plugins/framework/plugins/cli/bin/commands/release.ts` | icon-gen step in `wrapTauri`; `resolveCompositionIconKey` helper; `renderPng`; imports |
| `plugins/framework/plugins/cli/package.json` | add `@resvg/resvg-js` |
| `plugins/primitives/plugins/pane/core/route.ts` | `iconKey` on `AppRef` / `defineApp` |
| `plugins/apps/plugins/*/…/shell/core/app.ts` (~13) | pass `iconKey` to `defineApp` |
| `plugins/primitives/plugins/icon-picker/core/` | `svgNodesToString` + barrel re-export |
| `plugins/apps-core/plugins/app-icon/core/` | `appIconToSvg` + `AppIconSvgOptions` + barrel re-export |
| `plugins/apps-core/plugins/app-icon/check/index.ts` | `app-icon:key-in-sync` drift check |

Reused as-is: `resolveIconSvgNodes` (`icon-picker/server`), `run(...)` / `buildPluginTree`
/ `compositionsConfig` / `manifestItemToManifest` (already in the CLI), the existing
`bun x @tauri-apps/cli@2` invocation pattern.

## Verification (end-to-end, clean-checkout contract)

1. Confirm clean state: `tauri/src-tauri/icons/` absent (gitignored) —
   `git status --porcelain tauri/src-tauri/icons` empty.
2. `./equin build` then `./equin check app-icon:key-in-sync` passes; flip one
   app's `iconKey` to mismatch its `mdAppIcon(...)` → check fails.
3. Production path: `./equin release --composition sonata --target tauri`. It no
   longer aborts on missing `icon.icns`. Then:
   - `ls tauri/src-tauri/icons/` shows the 5 referenced files.
   - `…/target/release/bundle/macos/Sonata.app/Contents/Resources/icon.icns` exists; open
     the `.app`/`.dmg` and confirm the piano glyph renders.
4. Dev path (the server-side release passes `--dev` → `tauri dev`):
   `./equin release --composition sonata --target tauri --dev` — icon generation
   runs before `tauri dev`; dock/window shows the glyph.

## Risks / notes

- `@tauri-apps/cli icon` output filenames could not be executed in this worktree (no
  `node_modules`); the v2 default set and `icons/` output dir are well-established, and
  step 4's existence check fails loudly on any surprise rather than silently.
- Latent (flag, not fixed here): `docgen` full-import has no per-barrel try/catch and app
  web shells calling `mdAppIcon(MdXxx)` can throw under the barrel-import stub — worth a
  separate hardening task.
