import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  AdaptiveBar,
  AdaptiveBarCollapsed,
  type AdaptiveBarProps,
  type AdaptiveBarCollapsedProps,
  type AdaptiveBarOverflow,
  type AdaptiveBarAlign,
} from "./internal/adaptive-bar";
export {
  AdaptiveBarItem,
  isAdaptiveBarItem,
  type AdaptiveBarItemProps,
} from "./internal/bar-item";
export {
  AdaptiveBarYield,
  type AdaptiveBarYieldProps,
} from "./internal/bar-yield";
export {
  adaptiveBarReportSink,
  type AdaptiveBarFault,
  type AdaptiveBarFaultKind,
} from "./internal/diagnostics";

export default {
  description:
    "Overflow as relocation, not transformation: a bar that asks each widget for a smaller form of itself and moves the rest — as themselves, ONE live instance each, never rendered twice — into an always-mounted panel. Each occupant owns one stable portal container the bar re-parents imperatively, so a relocated slider is still the same slider mid-drag; measurement reads the real nodes, and every policy (which forms exist, how eagerly to yield) comes from the widget through action-presentation rather than from the host.",
  contributions: [],
} satisfies PluginDefinition;
