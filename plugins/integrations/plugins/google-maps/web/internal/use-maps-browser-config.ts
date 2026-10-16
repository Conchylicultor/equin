import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceError } from "@plugins/primitives/plugins/live-state/web";
import { mapsBrowserConfig } from "../../core";

/**
 * The public browser config the live map renders with. `loading` is the read
 * not having arrived — never a stand-in for `unset`, which is a settled answer
 * ("no key on this machine") a surface may prompt on. `error` is a failed read:
 * whether a key is stored is unknown, so a surface offers Retry, never "Set up".
 */
export type MapsBrowserConfigState =
  | { kind: "loading" }
  | { kind: "error"; error: ResourceError; refetch: () => Promise<void> }
  | { kind: "unset" }
  | { kind: "set"; browserKey: string; mapId: string | null };

export function useMapsBrowserConfig(): MapsBrowserConfigState {
  const result = useLive(mapsBrowserConfig);
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "error":
      return { kind: "error", error: result.error, refetch: result.refetch };
    case "ready":
      return result.data;
  }
}
