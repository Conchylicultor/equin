import { useConfigResult } from "@plugins/config_v2/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { Audience } from "../core";
import { audienceConfig, audienceOf } from "../shared/config";

/**
 * The user's audience, live. A state, not a stand-in: it decides what a
 * surface offers, so a reader renders its loading state until it is known
 * (the config is boot-preloaded, so that window is not observable after boot).
 */
export function useAudience(): ResourceResult<Audience> {
  return mapResource(useConfigResult(audienceConfig), audienceOf);
}
