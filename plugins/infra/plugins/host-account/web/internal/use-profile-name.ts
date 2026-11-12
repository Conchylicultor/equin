import { useConfigResult } from "@plugins/config_v2/web";
import {
  mapResource,
  useCombinedResources,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { profileName, profileNameConfig, type ProfileName } from "../../core";
import { useHostAccount } from "./use-host-account";

/**
 * Who the user is on screen (the profile-name setting's name over the OS account):
 * a name, or `anonymous` when the user turned their name off — `loading`
 * until both are known, never a placeholder name.
 */
export function useProfileName(): ResourceResult<ProfileName> {
  const read = useCombinedResources({
    account: useHostAccount(),
    settings: useConfigResult(profileNameConfig),
  });
  return mapResource(read, ({ account, settings }) =>
    profileName(account, settings),
  );
}
