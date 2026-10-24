import { useAudience } from "@plugins/audience/web";
import type { Audience } from "@plugins/audience/core";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";
import { isListedApp } from "./resolve-app";

/** Whether a launcher offers an app — {@link isListedApp} for this user. */
export type AppListing = (entry: { app: AppRef }) => boolean;

// One stable predicate per audience, so a memo keyed on it holds while the
// audience does.
const LISTINGS: Record<Audience, AppListing> = {
  user: (entry) => isListedApp(entry, "user"),
  developer: (entry) => isListedApp(entry, "developer"),
};

/**
 * Which apps the launchers offer this user, live: {@link isListedApp} bound to
 * the user's audience (Developer mode). Loading until the audience is known —
 * a launcher renders its loading state rather than guess which apps exist.
 */
export function useAppListing(): ResourceResult<AppListing> {
  return mapResource(useAudience(), (audience) => LISTINGS[audience]);
}
