import type { ReactElement } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  tabOriginLabel,
  useTabOrigin,
  type TabStamp,
} from "../internal/tab-origin";

/** The stamped tab as a badge: "this tab" highlighted, another one muted. */
export function TabOriginBadge({
  stamp,
}: {
  stamp: TabStamp;
}): ReactElement | null {
  const origin = useTabOrigin(stamp);
  const label = tabOriginLabel(origin);
  if (label === null) return null;
  return (
    <Badge variant={origin.kind === "this" ? "info" : "muted"}>{label}</Badge>
  );
}
