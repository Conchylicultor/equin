import { useSetConfig } from "@plugins/config_v2/web";
import { audienceConfig } from "../shared/config";

/** Switches Developer mode on or off. */
export function useSetDeveloperMode(): (on: boolean) => void {
  const set = useSetConfig(audienceConfig);
  return (on) => set("developerMode", on);
}
