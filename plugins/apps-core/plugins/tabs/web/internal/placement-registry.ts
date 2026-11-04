import { createContext, useContext } from "react";
import {
  defineInstallSink,
  type InstallSink,
} from "@plugins/primitives/plugins/scope/plugins/install-sink/web";

/**
 * The placement *capabilities* `apps`-side chrome needs to make routing
 * decisions — default placement, tear-off target, and the sets of placements
 * that follow the focused tab on `+` / wear the app theme — without `apps` ever
 * importing the `surface` plugin (which would cycle: `surface` → `apps`).
 *
 * This registry is **owned by `apps` but written by whichever body fills the
 * surface**, from an effect, for as long as it is mounted:
 *
 * - `surface`'s body derives the capabilities from its `Surface.Placement`
 *   contributions (the dependency direction stays `surface → apps`);
 * - `tab-surface`'s `AppTabsBody`, the docked-only fallback when no
 *   `Apps.Surface` is contributed, registers docked alone;
 * - `layout`'s error surfaces (load error, home missing, not found) register an
 *   EMPTY set — no placement, so no app owns the surface.
 *
 * They are alternatives in one conditional, so one sits at a time. Until the
 * first registration the sink is empty (`null`): the predicates read it as the
 * inert answer (`""` / `false`), and `usePlacementCapabilities` hands it on as
 * "not known yet" — which app owns `:root` waits for it (`theme-scope`).
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
 * Where a tab set's placement capabilities live: one per tab set (see
 * `TabsProvider`). The surface body filling a tab set writes it; the tab set
 * and its chrome read it back.
 */
export type PlacementRegistry = InstallSink<PlacementCapabilities>;

/**
 * Mint the registry of one tab set. Empty until the surface body registers,
 * which happens in an EFFECT — chrome mounted in that same commit asks before
 * the answer exists, which is why the render-path read is the subscribed
 * `useValue` and the predicates below take the value rather than fetching it.
 */
export function createPlacementRegistry(name: string): PlacementRegistry {
  return defineInstallSink<PlacementCapabilities>({
    name: `tabs.placement-capabilities:${name}`,
    what: "the placement capabilities of a tab set (registered by whichever body fills its surface: apps-core/surface's from its Surface.Placement contributions, tab-surface's docked-only AppTabsBody, or apps-core/layout's error surfaces as an empty set)",
  });
}

/**
 * The PAGE tab set's registry — the app's own surface. Page-global chrome
 * outside every tab set (the tab bar, the root theme scope, the global action
 * bar) reads this one through the functions below; an embedded tab set (an
 * `AppEmbed`) has its own, which nothing outside it reads.
 */
export const pagePlacementRegistry = createPlacementRegistry("page");

const PlacementRegistryContext = createContext<PlacementRegistry>(
  pagePlacementRegistry,
);

/** Provided by `TabsProvider`: the registry of the tab set a subtree is in. */
export const PlacementRegistryProvider = PlacementRegistryContext.Provider;

/**
 * The registry of the tab set this subtree belongs to — what a surface body
 * registers its capabilities into (`useEffect(() => registry.install(caps))`;
 * the disposer restores the previous occupant). Outside every `TabsProvider`
 * (the layout's error surfaces) it is the page's.
 */
export function usePlacementRegistry(): PlacementRegistry {
  return useContext(PlacementRegistryContext);
}

/**
 * One-shot read of the default placement id — for event handlers and effect
 * cleanups (the surface-mode teardown), which
 * run after registration and re-run on every invocation. Returns `""` until
 * `surface` registers. NEVER from a render path: use {@link useDefaultPlacement}
 * there, or the pre-registration `""` is cached for the component's life.
 */
export function peekDefaultPlacement(): string {
  return pagePlacementRegistry.peek()?.defaultId ?? "";
}

/**
 * Where to land when LEAVING `current` with nowhere recorded to go back to
 * (solo's exit on a fresh boot): the default placement, unless that IS
 * `current` — then the first other registered placement in control order.
 * Without the second arm a surface that boots into its default solo mode could
 * never be exited. `""` when nothing is registered yet. Value-in, like the
 * predicates below: the tab set passes its own registry's `peek()`.
 */
export function exitPlacementOf(
  caps: PlacementCapabilities | null,
  current: string,
): string {
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
  return pagePlacementRegistry.useValue()?.defaultId ?? "";
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
  return pagePlacementRegistry.useValue();
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
 * Whether the surface may hold no tab at all in mode `id` (the desktop). For
 * the tab manager's actions (closing the last tab, switching mode), which run
 * after the surface registered and pass their registry's `peek()`. Not
 * registered yet (`null`) is `false`: the surface then keeps a tab, the safe
 * direction.
 */
export function placementAllowsEmpty(
  caps: PlacementCapabilities | null,
  id: string,
): boolean {
  return caps?.allowsEmpty.has(id) ?? false;
}
