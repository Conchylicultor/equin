import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useAppLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { queueRoute } from "@plugins/debug/plugins/queue/core";
import { navIcons } from "@plugins/ui/plugins/icons/core";

/** The Job queue row's trailing control: open Debug → Queue, the full list. */
export function OpenQueueAction() {
  const inAppLinkProps = useAppLinkProps();
  return (
    <IconButton
      icon={navIcons.expand}
      label="Open queue"
      {...inAppLinkProps(queueRoute.link(debugApp, {}))}
    />
  );
}
