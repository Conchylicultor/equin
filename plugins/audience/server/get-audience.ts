import { getConfig } from "@plugins/config_v2/server";
import type { Audience } from "../core";
import { audienceConfig, audienceOf } from "../shared/config";

/** The user's audience now (the Developer mode setting). */
export function getAudience(): Audience {
  return audienceOf(getConfig(audienceConfig));
}
