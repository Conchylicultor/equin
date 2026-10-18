import { defineInstallSink } from "@plugins/primitives/plugins/scope/plugins/install-sink/web";

/**
 * The placement *capabilities* `apps`-side chrome needs to make routing
 * decisions — default placement, tear-off target, and the sets of placements
 * that follow the focused tab on `+` / wear the app theme — without `apps` ever
 * importing the `surface` plugin (which would cycle: `surface` → `apps`).
 *
 * This registry is **owned by `apps` but written by `surface`**: `surface`'s
 * body derives the capabilities from its `Surface.Placement` contributions and
 * calls {@link registerPlacementCapabilities}. The dependency direction stays
 * `surface → apps`. Until the first registration the sink is empty, which every
 * consumer reads as the inert answer (`""` / `false`) — an accepted one-frame
 * seam on the very first commit, before any user interaction.
 */
export interface PlacementCapabilities {
  /** The id of the default surface mode (the one the surface boots into). */
  defaultId: string;
  /** Every registered placement id. Lets the provider resolve a stale/empty
   * stored mode to `defaultId`, so the published mode is always a real id. */
  ids: Set<string>;
  /** Modes for which `+` reads as "new window" (i.e. windows mode). */
  newTabFollows: Set<string>;
  /** Modes whose chrome wears the app theme. */
  appThemeScope: Set<string>;
  /** Modes that draw their own frame: no tab bar, no app rail, and the global
   * action bar as its floating dot (solo, the desktop). */
  ownsChrome: Set<string>;
  /** Modes in which the surface may hold no tab at all (the desktop). */
  allowsEmpty: Set<string>;
}

/**
 * The one slot holding the installed placement set. Page-global by design: it
 * is which placement plugins EXIST (the default, which ones the `+` follows,
 * which wear the app theme), identical across every surface and window — not
 * per-surface state — so it is a sink, not a scoped store.
 *
 * Empty until `surface`'s body registers, which happens in an EFFECT. Chrome
 * mounted in that same commit (the tab bar, the chrome theme scope) therefore
 * asks before the answer exists, which is why the render-path read is the
 * subscribed {@link usePlacementCapabilities} and the predicates below take the
 * value rather than fetching it.
 */
const placementSink = defineInstallSink<PlacementCapabilities>({
  name: "tabs.placement-capabilities",
  what: "the placement capabilities (registered by apps-core/surface's body from its Surface.Placement contributions)",
});

/**
 * Publish the latest placement capabilities. Called by the `surface` body from
 * an effect keyed on its contributions; subscribers re-render when the registry
 * first populates (or the default changes). The returned disposer restores the
 * previous capabilities, so the effect's cleanup is the disposer itself.
 */
export function registerPlacementCapabilities(
  caps: PlacementCapabilities,
): () => void {
  return placementSink.install(caps);
}

/**
 * One-shot read of the default placement id — for event handlers and effect
 * cleanups (the surface-mode teardown), which
 * run after registration and re-run on every invocation. Returns `""` until
 * `surface` registers. NEVER from a render path: use {@link useDefaultPlacement}
 * there, or the pre-registration `""` is cached for the component's life.
 */
export function peekDefaultPlacement(): string {
  return placementSink.peek()?.defaultId ?? "";
}

/**
 * One-shot read of where to land when LEAVING `current` with nowhere recorded
 * to go back to (solo's exit on a fresh boot): the default placement, unless
 * that IS `current` — then the first other registered placement in control
 * order. Without the second arm a surface that boots into its default solo
 * mode could never be exited. Returns `""` until `surface` registers.
 */
export function peekExitPlacement(current: string): string {
  const caps = placementSink.peek();
  if (caps === null) return "";
  if (caps.defaultId !== current) return caps.defaultId;
  for (const id of caps.ids) if (id !== current) return id;
  return caps.defaultId;
}

/**
 * Reactive read of the default placement id. Returns `""` until `surface`
 * registers, then re-renders consumers once the registry populates.
 */
export function useDefaultPlacement(): string {
  return placementSink.useValue()?.defaultId ?? "";
}

/**
 * Reactive read of the full capabilities snapshot — `null` until `surface`
 * registers. Backs the tab provider's mode resolution: an empty/stale stored
 * mode id resolves to `defaultId` the moment the registry populates, so every
 * mode consumer (theme scope, mode control, persistence) agrees with what the
 * surface actually renders. It is also the ONLY way a render path can obtain
 * the value the two predicates below need.
 */
export function usePlacementCapabilities(): PlacementCapabilities | null {
  return placementSink.useValue();
}

/**
 * Whether `+` reads as "new window" in surface mode `id` (i.e. windows mode).
 *
 * Takes the capabilities rather than reading the sink: a predicate that cannot
 * sample cannot be sampled from render, and the only way a component can hold
 * `caps` is {@link usePlacementCapabilities}, which subscribes. Before this,
 * the tab bar asked in its component body and could keep "not a window" from
 * boot, because the registry lands in a different subtree's effect and the bar
 * subscribed to nothing that changes when it does. `null` (not registered yet)
 * is `false`.
 */
export function placementIsNewTabFollows(
  caps: PlacementCapabilities | null,
  id: string,
): boolean {
  return caps?.newTabFollows.has(id) ?? false;
}

/**
 * Whether the focused chrome wears the app theme when the focused tab uses
 * placement `id`. Same value-in shape, for the same reason — and here the
 * stale answer reached further: this one decides the `:root` token layer for
 * the whole page, so a sampled `false` left the rail, tab bar, toaster and
 * `:root` on a different theme than the focused app's. `null` is `false`.
 */
export function placementHasAppThemeScope(
  caps: PlacementCapabilities | null,
  id: string,
): boolean {
  return caps?.appThemeScope.has(id) ?? false;
}

/**
 * Whether surface mode `id` draws its own frame — the layout then mounts no tab
 * bar and no app rail, and the global action bar floats instead of docking into
 * the (absent) tab bar. Same value-in shape as the predicates above. `null`
 * (not registered yet) is `false`.
 */
export function placementOwnsChrome(
  caps: PlacementCapabilities | null,
  id: string,
): boolean {
  return caps?.ownsChrome.has(id) ?? false;
}

/**
 * Whether the surface may hold no tab at all in mode `id` (the desktop). One-shot
 * read for the tab manager's actions (closing the last tab, switching mode),
 * which run after the surface registered. Not registered yet is `false`: the
 * surface then keeps a tab, the safe direction.
 */
export function peekPlacementAllowsEmpty(id: string): boolean {
  return placementSink.peek()?.allowsEmpty.has(id) ?? false;
}
