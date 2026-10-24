# Developer mode — the user's audience

## Context

The owner of an instance is a developer; most users are not. Today every user
sees the same launchers, full of developer tools (Studio, Debug, Deploy, Demo…).
We want a **Developer mode** setting so the experience differs by who the user
is — first for which apps the launchers offer, later for other things (e.g.
different agent prompts for users vs developers).

Decided with the user:

- Developer apps are **hidden for regular users, shown in Developer mode**:
  Studio, Browser, Debug, Demo, Deploy, Mail, and the Website (`equin`).
- "Hidden" means what `listed: false` already means: out of every launcher,
  still reachable at its URL. Not a security boundary.
- Per-app show/hide overrides are a later layer, not this change.

## Design

### 1. `audience` — who the user is, not a feature flag

New top-level plugin `plugins/audience` (a leaf: apps-core and later
conversations import it, so it must not live under either).

- `core/`: `type Audience = "user" | "developer"` (a closed list → plain data,
  no slot).
- `shared/config.ts`: `audienceConfig = defineConfig({ fields: { developerMode:
  boolField({ default: false, label: "Developer mode", … }) } })`. Stored as a
  bool (typed end-to-end; an `enumField` reads back as `string`), presented as
  an `Audience`.
- `web/`: `ConfigV2.WebRegister`, and `useAudience(): ResourceResult<Audience>`
  (over `useConfigResult` — the value decides what a surface asserts, so the
  unknown window is a state, per the config_v2 rule; preloaded
  boot-and-keep, so it is not observable after boot).
- `server/`: `ConfigV2.Register` (portable) and `getAudience()` for server
  features to come (prompts).

Features declare *who they are for*; they never branch on `if (devMode)`.

### 2. Apps declare their audience

- `defineApp({ audience?: "developer" })` → `AppRef.audience`
  (`plugins/primitives/plugins/pane/core/route.ts`), stored only when set, like
  `listed`. Projected into the server's `declaredApps` by
  `codegen/core/app-declarations-gen.ts`.
- The seven app shells (`plugins/apps/plugins/<app>/plugins/shell/core/app.ts`)
  declare `audience: "developer"`.

### 3. One listing answer for every launcher

`isListedApp(entry)` (apps-core `web/internal/resolve-app.ts`) becomes
`isListedApp(entry, audience)` — the audience is a required argument, so a
launcher cannot forget it (type error) — plus
`useAppListing(): ResourceResult<(entry) => boolean>` binding it to
`useAudience()`. Rule: unlisted (`listed: false`) never; a `developer` app only
for the developer audience.

Consumers (each renders its loading state while unknown):

- Home gallery — `home/plugins/app-cards/web/components/app-grid.tsx`
- App rail — `apps-core/plugins/app-rail/web/components/app-rail.tsx`
- Launcher popover — `apps-core/plugins/app-launcher/web/components/app-launcher.tsx`
- Desktop launcher — `desktop/plugins/launcher/web/internal/use-launcher-apps.ts`
- Menu-bar grid — `menu-bar/plugins/app-grid/web/components/app-grid.tsx`
  (did not filter `listed` before; now goes through the same listing).

Out of scope: the installable set (web manifest, menu-bar shims) keeps
following `listed` only — a developer app stays installable.

### 4. The switch in Settings

Sub-plugin `plugins/audience/plugins/settings` (separate so `audience` stays a
leaf below the Settings app): a **Profile** Settings sidebar entry opening a
pane with the *Developer mode* switch and what it changes. The field also
appears in Settings → Config like every descriptor.

## Verification

- `./equin build` (generates the config origin), `./equin check`.
- Unit test for `isListedApp(entry, audience)`.
- Screenshot `/home` with Developer mode off (developer apps absent) and on
  (present), and the Settings → Profile pane.
