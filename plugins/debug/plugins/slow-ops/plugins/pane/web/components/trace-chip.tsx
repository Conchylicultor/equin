import type { ReactElement, ReactNode } from "react";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { useAppLink } from "@plugins/apps-core/plugins/tabs/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const boltIcon = symbol("bolt");

/**
 * A chip opening one trace in the Debug app. A component, so a table cell can
 * render it and still go through an embed's navigation boundary (the hook
 * form), which a cell calling the free `appLink` would skip.
 */
export function TraceChip({
  traceId,
  children = "trace",
}: {
  traceId: string;
  children?: ReactNode;
}): ReactElement {
  const appLink = useAppLink();
  return (
    <LinkChip
      leading={<Icon icon={boltIcon} className="icon-auto" />}
      activation={appLink(traceDetailRoute.link(debugApp, { id: traceId }))}
    >
      {children}
    </LinkChip>
  );
}
