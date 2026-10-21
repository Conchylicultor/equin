import { getConfig } from "@plugins/config_v2/server";
import type { AvatarSpec } from "@plugins/fields/plugins/avatar/core";
import { prepromptsConfig } from "../../shared/config";

export interface ResolvedPreprompt {
  id: string;
  title: string;
  prompt: string;
  /** Chosen icon/color. `null` when no icon is picked. */
  icon: AvatarSpec | null;
}

/**
 * Resolve a preprompt id (a config list-item UUID) to its full config item
 * (id, title, trimmed prompt, icon). Returns undefined when the id is absent,
 * no longer present in the config (e.g. the preprompt was deleted), or
 * resolves to empty text — callers fail-soft over a dangling reference.
 */
export function resolvePrepromptItem(
  id: string | null | undefined,
): ResolvedPreprompt | undefined {
  if (!id) return undefined;
  const { preprompts } = getConfig(prepromptsConfig);
  const item = preprompts.find((p) => p.id === id);
  if (!item) return undefined;
  const prompt = item.prompt.trim();
  if (!prompt) return undefined;
  // Only carry a meaningful icon (one with a picked name); the avatarField
  // default is an all-null spec which would render a blank disc.
  const icon = item.icon?.icon != null ? item.icon : null;
  return { id: item.id, title: item.title, prompt, icon };
}
