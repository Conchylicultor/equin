import type { ReactElement, ReactNode } from "react";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { useAppLink } from "@plugins/apps-core/plugins/tabs/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { traceDetailRoute } from "../../core";

const boltIcon = symbol("bolt");

/**
 * The one chip opening a trace in Debug → Slow Events — what a report row's
 * summary, a table cell or a detail header renders to link its evidence. A
 * component, so a table cell can render it and still go through an embed's
 * navigation boundary (the hook form), which a cell calling the free `appLink`
 * would skip.
 */
export function TraceChip({
  traceId,
  children = "View trace",
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
