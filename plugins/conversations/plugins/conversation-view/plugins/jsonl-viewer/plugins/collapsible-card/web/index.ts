import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  CollapsibleCard,
  CardHeaderAction,
  TimelineLine,
  type CollapsibleCardProps,
} from "./components/collapsible-card";

export default {
  collapsed: true,
  description:
    "Disclosure-card primitive: the whole header row is the toggle (no chevron; aria-expanded + an Expand/Collapse label carry the state), optional interactive sibling aside (never nested), and a collapsible body. One uniform chrome; semantic accents live in the label, the error flag, and the call-site className. Pure chrome — it depends on no domain component.",
  contributions: [],
} satisfies PluginDefinition;
