import { useMemo } from "react";
import { useAudience } from "@plugins/audience/web";
import { useComposition } from "@plugins/framework/plugins/web-sdk/core";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";
import { isListedApp } from "./resolve-app";

/** Whether a launcher offers an app — {@link isListedApp} for this user. */
export type AppListing = (entry: { app: AppRef }) => boolean;

const NONE: readonly string[] = [];

/**
 * Which apps the launchers offer this user, live: {@link isListedApp} bound to
 * the user's audience (Developer mode) and the deployed composition's unlisted
 * apps. Loading until the audience is known — a launcher renders its loading
 * state rather than guess which apps exist.
 */
export function useAppListing(): ResourceResult<AppListing> {
  const unlisted = useComposition().unlisted ?? NONE;
  const audience = useAudience();
  // One stable predicate per (audience, composition), so a memo keyed on it
  // holds while both do.
  const listings = useMemo(
    () => ({
      user: (entry: { app: AppRef }) => isListedApp(entry, "user", unlisted),
      developer: (entry: { app: AppRef }) =>
        isListedApp(entry, "developer", unlisted),
    }),
    [unlisted],
  );
  return mapResource(audience, (a) => listings[a]);
}
