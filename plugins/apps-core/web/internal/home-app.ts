import { useComposition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "../slots";
import type { ActiveApp } from "./use-active-app";

/**
 * The deployed composition's home app — the app owning bare `/`, the seed of a
 * fresh tab set and the app launcher's click. Declared per composition (its
 * manifest `home`, baked into the web registry at build time), never by an app:
 * there is no code-level way to claim the homepage, and no load-order fallback.
 */
export type HomeApp =
  /** The home app, registered. */
  | { kind: "app"; app: ActiveApp }
  /** The composition holds no app — nothing to land on. */
  | { kind: "none" }
  /**
   * The composition declares `id` but no `Apps.App` with that id registered —
   * its shell failed to load (or has not yet). Never answered with another app.
   */
  | { kind: "unregistered"; id: string };

/** {@link HomeApp} for a declared home id among the registered apps. Pure. */
export function homeApp(
  apps: readonly ActiveApp[],
  homeId: string | null,
): HomeApp {
  if (homeId === null) return { kind: "none" };
  const app = apps.find((a) => a.id === homeId);
  return app ? { kind: "app", app } : { kind: "unregistered", id: homeId };
}

/** The deployed composition's {@link HomeApp}, live over the `Apps.App` registry. */
export function useHomeApp(): HomeApp {
  const { home } = useComposition();
  return homeApp(Apps.App.useContributions(), home);
}
