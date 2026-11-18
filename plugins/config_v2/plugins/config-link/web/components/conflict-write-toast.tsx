import { useEffect } from "react";
import { onConfigWriteRefused } from "@plugins/config_v2/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useConfigPathLink } from "../internal/use-config-link";

/**
 * Says why a config change did nothing while its document is in conflict, and
 * links to the config to resolve it: the app shows the new defaults while the
 * user's own values are parked, so a change made from the screen would have
 * replaced them (config_v2's `useSetConfig` refuses it).
 */
export function ConflictWriteToast() {
  const linkTo = useConfigPathLink();
  const toast = useToast();
  useEffect(
    () =>
      onConfigWriteRefused("conflict", ({ storePath, scopeId }) =>
        toast({
          type: "config-write-refused-conflict",
          variant: "error",
          title: "Config has a conflict — resolve it first",
          description: scopeId ? `${storePath} (${scopeId})` : storePath,
          category: "other",
          liveAction: { label: "Resolve", link: linkTo(storePath) },
        }),
      ),
    [linkTo, toast],
  );
  return null;
}
