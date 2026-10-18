# install-sink

An **installed sink** is a named slot that one layer fills and another layer
calls. It exists because the layering only goes one way: `apps-core/tabs`
imports `primitives/pane`, so the pane cannot import tabs back to reach the
cross-app navigator. Instead the pane declares a slot, tabs drops its `navigate`
into it when its provider mounts, and the pane calls whatever is in the slot
without ever knowing tabs exists. The history adapter, the overlay-boundary
fallback and the live-store pointer are the same shape.

```ts
// the declaration, at module scope in the LOWER layer
export const appNavSink = defineInstallSink<AppNavigator>({
  name: "pane.app-nav",
  what: "the cross-app navigator (installed by apps-core/tabs at provider mount)",
});

// the install, in the HIGHER layer's provider effect
useEffect(() => appNavSink.install(navigate), [navigate]);

// a render path — subscribed, so a late install re-renders this component
const canNavigate = appNavSink.useInstalled();

// an event path — sampled at click time, after installation
onClick={() => appNavSink.peekOrThrow()(url, { newTab })}
```

## Why a render-phase read is wrong

The slot is filled **late**. Installing happens when a provider mounts, which
means it happens in an effect — one commit after the first render of everything
that mounted alongside that provider.

So a component rendering in that same commit asks the question before the answer
exists, and gets "nothing is installed". If it asked from a `useMemo`, a
`useState` initializer, or a plain call in its body, that answer is now frozen:
the slot is in no dependency array, so nothing re-runs the check. Whether a
component got the right answer comes down to whether its plugin happened to load
before or after the provider.

That is not hypothetical. The pane's Expand button asked `canNavigateApp()`
inside a `useMemo`, so a conversation pane hosted by another app was told there
was nowhere to expand to and never painted the button — for the life of the
pane. Panes in the deferred plugin tier mounted after the effect and worked
fine, so the bug looked like it belonged to one pane.

The cure is that a render path has no non-reactive spelling of the presence
question. `useInstalled()` is the only presence answer this primitive offers,
and it subscribes.

## The API

| Member | Returns | Call it from |
|---|---|---|
| `install(value)` | `() => void` — a disposer restoring the **previous** occupant | an effect, or boot |
| `useInstalled()` | `boolean`, subscribed | render |
| `useValue()` | `T \| null`, subscribed | render |
| `peek()` | `T \| null`, one-shot | an event handler or effect, never render |
| `peekOrThrow()` | `T`; throws naming the sink | an event handler or effect, never render |

A sink declared with a `fallback` is never empty, so it has no presence
question: `useValue()` and `peek()` return `T`, and `useInstalled()` /
`peekOrThrow()` are not on its type at all. One implementation, two overloads.

Writing bails when the new value is `Object.is`-equal to the current one, so
re-installing the same implementation re-renders nobody.

## `peek…` is a contract, not a style preference

Sampling the slot imperatively is perfectly correct from an event handler or an
effect — both run after installation, and both re-run every time. It is only
wrong during render. No type can carry "not during render", so the invariant
lands on a lint rule, and a lint rule can only recognise a sample if every
sample looks the same. Hence the name: `install-sink/no-render-phase-peek` bans
a call named `peek…` that executes during render, and points at the hook to use
instead.

Two things follow. Do not rename these members at a call site. And do not wrap
one in a differently-named getter — `canNavigateApp()` was exactly that wrapper,
and it is how the original bug was spelled; `install-sink/no-laundered-peek`
catches the hop. A third rule, `install-sink/no-adhoc-install-sink`, catches the
sink that never reaches this primitive at all (a module-scope `let` written by an
exported `set*`/`install*`/`register*` function and read back by another
function in the same file).

That third rule runs **only in the web runtime**, and only in a file with no
subscription path of its own (no `useSyncExternalStore`, no exported
`subscribe…`, no `Set<() => void>` of listeners). Both narrowings are deliberate.
A `server/` or `core/` module has no render at all, so "a render-path reader
caches the pre-install answer" would be a false statement there — and a store
split across a store file and a hook file (the value and listeners here, the
`useSyncExternalStore` in the consumer) really can subscribe, the evidence just
isn't in one file. The accepted false negative: a sink declared in `core/` and
read from render is missed, though the render side of it still meets
`no-render-phase-peek` / `no-laundered-peek`.

## The disposer restores, it does not clear

`install(value)` hands back a disposer that puts the **previous** occupant back —
including the fallback, if the sink has one. Teardown code therefore never has
to remember what the default was.

A disposer whose value has since been superseded does nothing at all. That
matters in two ordinary situations: React StrictMode double-mounts an effect
(install, re-install, then dispose the first), and a provider swap installs the
replacement before tearing down the old one. Restoring blindly in either case
would empty a slot somebody had just filled.

## Related

- `primitives/report-sink` is the write-side twin — a slot you *emit into*
  rather than *call*.
- Design and rationale:
  [`research/2026-08-17-global-installed-sink-render-read.md`](../../../../../../research/2026-08-17-global-installed-sink-render-read.md).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Installed-sink primitive: defineInstallSink declares the module-level slot a higher layer installs an implementation into and a lower layer calls (the navigator, the history adapter, the overlay fallback). Presence is answerable from render ONLY through the subscribed useInstalled(), so a late install re-renders whoever asked early; the imperative sample is named peek… so install-sink/no-render-phase-peek can keep it out of render.
- Cross-plugin:
  - Imported by:
    - `apps-core/tabs`
    - `apps/desktop/launcher`
    - `apps/desktop/switcher`
    - `apps/desktop/windows`
    - `primitives/overlay/overlay-boundary`
    - `primitives/pane`
- Web:
  - Exports (types):
    - `FilledInstallSink`
    - `InstallSink`
    - `InstallSinkOptions`
  - Exports (values): `defineInstallSink`

<!-- AUTOGENERATED:END -->
