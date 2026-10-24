# Pre-paint theme cache — app-aware + configured-mode (v2)

> Follow-up to [`2026-06-11-global-prepaint-theme-cache.md`](./2026-06-11-global-prepaint-theme-cache.md).
> That plan's Leg A was dropped on rebase in favor of main's equivalent
> `79bf39b42` (single global envelope, resolved `dark` bit). This v2 re-applies
> the two refinements that convergence left out — both documented in the prior
> doc's convergence note as "accepted for now".

## Context

The critical-css pre-paint cache (`theme-engine`'s `theme-cache.ts` writer +
the inline replay `<script>` in `web-core/web/index.html`) eliminates the
theme FOUC on hard reload by replaying the last-painted CSS before React
mounts. Main's adopted version has two staleness gaps. Both are limited to the
pre-mount frames and self-heal once `ThemeInjector` runs, but both are visibly
wrong for a beat:

1. **Not app-aware.** The envelope is a single global blob holding whichever
   app last wrote it. With per-app *forked* themes, hard-reloading app B after
   visiting app A replays A's colors for the first frames.
2. **Frozen dark bit.** It stores the resolved `dark` boolean from write time
   instead of the configured `colorMode`. For `colorMode: "system"`, an OS
   appearance flip between sessions replays the stale scheme until mount.

Goal: key the cache by app *path* and store the configured `colorMode` so the
inline script re-resolves `"system"` against live `matchMedia` on every load.
Both fixes are confined to the writer (`theme-cache.ts` + `ThemeInjector`) and
the plugin-agnostic inline replay script — no token/group/preset knowledge
leaks into web-core (boundary rule R10 preserved).

## Design

### 1. Envelope v2 — `theme-engine/web/internal/theme-cache.ts`

Replace the single-blob v1 shape with a per-app-path `entries` map and store
the configured mode:

```ts
const KEY = "theme-engine:critical-css"; // unchanged

type CachedColorMode = "light" | "dark" | "system";

interface PaintCacheEntry {
  /** styleId (`theme-engine-<group>`) → full `:root{…}.dark{…}` CSS text. */
  styles: Record<string, string>;
  /** CONFIGURED color mode (not the resolved dark bit) — the script re-resolves "system". */
  mode: CachedColorMode;
}

interface CriticalCssEnvelope {
  v: 2;
  /** key = app path ("/agents", "/files", …); "" = global / non-app route. */
  entries: Record<string, PaintCacheEntry>;
}
```

- **Drop the v1 `groups` field** — nothing reads it (the inline script ignores
  it; `ThemeInjector`'s orphan-pruning derives live ids from contributions, not
  the cache). Confirmed by grep: only `theme-injector.tsx` wrote it.
- **`writeCriticalCss` becomes read-merge-write** (it must preserve other apps'
  entries, since only one app is mounted per page):

```ts
export function writeCriticalCss(opts: {
  appPath: string | undefined;
  styles: Record<string, string>;
  mode: CachedColorMode;
  forked: boolean;
}): void {
  // read existing envelope, tolerate corrupt/v1 → fresh { v: 2, entries: {} }
  // key = opts.appPath ?? ""
  // entries[key] = { styles, mode }
  // if !forked && appPath set: ALSO entries[""] = { styles, mode }
  //   (an unforked app's resolved CSS *is* the global theme)
  // a forked app NEVER writes entries[""] (must not clobber the global)
  // write back; existing try/catch quota guard stays
}
```

Keep the existing `try/catch` no-op-on-quota guard. Update the file header
comment to describe the v2 `entries` shape (it is the contract with the inline
script — change both together).

### 2. Writer — `theme-engine/web/components/theme-injector.tsx`

- Switch `useCurrentAppId()` → `useActiveApp()` to obtain `path`. `scopeId =
  active ? \`app:${active.id}\` : undefined` is unchanged (`useCurrentAppId` is
  literally `useActiveApp()?.id`), so scope behavior is byte-identical.
- Read the **configured** mode: `const { colorMode } = useConfig(themeEngineConfig,
  { scopeId }) as { colorMode: CachedColorMode }`. Keep `useResolvedColorMode`
  driving `ColorModeApplier`'s live `.dark` class — unchanged.
- Replace the `cacheRef.current.dark = resolved === "dark"` render-body write
  with a ctx written in the render body (same synchronous pattern, so it is
  current before the flush microtask):
  ```ts
  ctxRef.current = { appPath: active?.path, colorMode, forked };
  ```
- `flush()` reads `ctxRef.current` + the styles map and calls the new
  `writeCriticalCss({ appPath, styles, mode: colorMode, forked })`. **Keep**:
  - the torn-cache guard `map.size < groupCountRef.current` (pending groups
    don't report → flush waits for all groups);
  - building `styles[styleIdFor(groupId)]` with the **full** `theme-engine-<group>`
    keys (the inline script uses the key directly as the `<style>` id, which
    GroupStyle then adopts by id — must not change to bare groupId).
- Replace `useEffect(scheduleFlush, [resolved, scheduleFlush])` with
  `useEffect(scheduleFlush, [active?.path, colorMode, forked, scheduleFlush])`
  so a pure app-switch / mode-only / fork-toggle change persists even when the
  CSS text is unchanged. (Re-flushing on a bare OS scheme flip is no longer
  needed: the stored `mode` is `"system"`, so the cache is already correct.)
- `persistActiveForkedScope` wiring and the orphan-style pruning effect stay
  as-is (pruning derives live ids from `groups`, unaffected by per-app keying;
  replay is always for one app per page load).

### 3. Inline replay script — `web-core/web/index.html`

Still plugin-agnostic (R10): knows only the key, the v2 shape, and the
`theme-engine-*` id convention.

```js
var prefersDark = !!(window.matchMedia &&
  window.matchMedia("(prefers-color-scheme: dark)").matches);
try {
  var env = JSON.parse(localStorage.getItem("theme-engine:critical-css"));
  if (env && env.v === 2 && env.entries) {
    var path = location.pathname, keys = [], k;
    for (k in env.entries) if (k !== "" && (path === k || path.indexOf(k + "/") === 0)) keys.push(k);
    keys.sort(function (a, b) { return b.length - a.length; }); // longest prefix wins
    var entry = (keys[0] && env.entries[keys[0]]) || env.entries[""];
    if (entry && entry.styles) {
      for (var id in entry.styles) {
        if (!Object.prototype.hasOwnProperty.call(entry.styles, id)) continue;
        var el = document.createElement("style");
        el.id = id; el.textContent = entry.styles[id];
        document.head.appendChild(el);
      }
      var m = entry.mode;
      document.documentElement.classList.toggle("dark",
        m === "dark" || (m !== "light" && prefersDark));
      return;
    }
  }
} catch (e) { /* corrupt / v1 / unavailable → cold floor below */ }
// cold floor: pick scheme from OS so the neutral loading floor paints right
if (prefersDark) document.documentElement.classList.add("dark");
```

- Path match mirrors `appMatchesPath` in `use-active-app.ts` exactly
  (`path === k || path.startsWith(k + "/")`), with explicit **longest-prefix**
  selection (sort desc) so `/studio/x` beats a `/` root entry.
- Old v1 envelopes (no `entries`) fall through to the cold floor once, then
  `ThemeInjector` rewrites the v2 cache on mount.
- Update the surrounding comment to point at `theme-cache.ts` as the contract
  owner and describe the per-app-path + configured-mode behavior.

### 4. Docs (contract changes — update alongside code)

- `web-core/web/theme/CLAUDE.md` — warm-path description: per-app-path keying +
  configured `mode` vs resolved `dark`.
- `.claude/skills/theme/SKILL.md` (line ~26) — pre-paint bullet: v2 `entries`,
  configured mode, longest-prefix match.

## Files to modify

| File | Change |
|---|---|
| `plugins/ui/plugins/theme-engine/web/internal/theme-cache.ts` | v2 envelope, read-merge-write `writeCriticalCss`, drop `groups`, header comment |
| `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx` | `useActiveApp`, configured `colorMode`, ctxRef, new flush signature, flush deps |
| `plugins/framework/plugins/web-core/web/index.html` | inline script: v2 + longest-prefix match + `mode` re-resolution + comment |
| `plugins/framework/plugins/web-core/web/theme/CLAUDE.md` | doc: per-app + mode |
| `.claude/skills/theme/SKILL.md` | doc: per-app + mode |

`writeCriticalCss` has exactly one caller (`theme-injector.tsx`), so the
signature change is contained. `use-color-mode.ts` is **unchanged**.

## Edge cases

| Case | Behavior |
|---|---|
| OS scheme flips while cached `"system"` | Re-resolved against live `matchMedia` each load — never stale (the fix). |
| Hard-reload app B after visiting forked app A | `entries["/B"]` (or `""` if B unforked) replays B's theme, not A's (the fix). |
| Non-app route (`/a/:id`) | `active` undefined → key `""` → global entry. |
| Unforked app | Writes its own path entry **and** `""` (its CSS is the global theme). |
| Forked app | Writes only its path entry; `""` untouched. |
| App un-forks | `forked` flips false → next flush updates `""` correctly. |
| Two tabs, different apps | Independent keys; narrow read-merge-write window, same self-heal as today — no regression. |
| Stale v1 envelope after deploy | `v === 2` check fails → cold floor once → rewritten on mount. |
| Removed app's path key lingers | Unreachable orphan, bounded by app count, harmless. |
| Quota exceeded | `try/catch` no-op → cache miss → cold floor. |

## Implementation order

1. `theme-cache.ts` v2 shape + read-merge-write `writeCriticalCss`.
2. `theme-injector.tsx` wiring (`useActiveApp`, configured mode, ctxRef, flush).
3. `index.html` inline script.
4. Docs (`web-core/web/theme/CLAUDE.md`, theme SKILL).
5. `./equin build` (type-check across the signature change; doc regen).

## Verification

1. `./equin build` passes (type-check, plugin-boundaries — no new
   cross-plugin edge; web-core stays plugin-agnostic). Inspect
   `web-core/dist/index.html`: inline script verbatim, `v === 2` branch present.
2. **Per-app**: fork a theme on app A (e.g. `/agents`), visit unforked app B
   (e.g. `/files`), hard-reload B → pre-paint frame shows B's/global colors,
   not A's. Inspect `localStorage["theme-engine:critical-css"]` → `v: 2`, an
   `entries` map with per-path keys + `""`, each carrying `mode`.
3. **Configured mode**: set `colorMode: "system"`, reload (entry stores
   `"system"`). Flip the OS appearance, hard-reload without mounting-then-
   changing → pre-paint frame matches the new OS scheme. Repeat with
   `colorMode: "light"`/`"dark"` → frame fixed regardless of OS.
4. **Cold/upgrade**: `localStorage.clear()` (or leave a v1 blob), hard-reload →
   no crash, OS-scheme cold floor, then the v2 cache is written on mount.
5. **Scripted first-frame check** (catch pre-mount frames):
   `bun run playwright screenshot --wait-for-timeout 50 --viewport-size "1280,800"
   http://<wt>.localhost:9000/agents /tmp/frame0.png` after warming each app's
   cache; compare against the steady-state screenshot.
