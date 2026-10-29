import { useEffect } from "react";
import { onConfigWriteRefused } from "@plugins/config_v2/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { useConfigPathLink } from "../internal/use-config-link";

/**
 * Says why a config change did nothing while its document is in conflict, and
 * links to the config to resolve it: the app shows the new defaults while the
 * user's own values are parked, so a change made from the screen would have
 * replaced them (config_v2's `useSetConfig` refuses it).
 */
export function ConflictWriteToast() {
  const linkTo = useConfigPathLink();
  useEffect(
    () =>
      onConfigWriteRefused("conflict", ({ storePath, scopeId }) =>
        showToast({
          variant: "error",
          title: "Config has a conflict — resolve it first",
          description: scopeId ? `${storePath} (${scopeId})` : storePath,
          action: { label: "Resolve", link: linkTo(storePath) },
        }),
      ),
    [linkTo],
  );
  return null;
}
