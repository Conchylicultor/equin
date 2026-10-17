import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { ControlPanel } from "./internal/namespace";
export {
  ControlPanelPopover,
  type ControlPanelPopoverProps,
} from "./internal/control-panel-popover";
export { type ControlPanelWidthNeed } from "./internal/width-need";
export {
  panelOverflowReportSink,
  type PanelOverflowFault,
} from "./internal/overflow-guard";
export {
  usePanelStack,
  type PanelStackApi,
  type PanelStackEntry,
} from "./internal/stack-context";
export { type ControlPanelStackProps } from "./internal/panel-stack";
export {
  type ControlPanelProps,
  type ControlPanelSectionProps,
  type ControlPanelFooterProps,
  type ControlPanelEmptyProps,
  type ControlPanelRuleListProps,
} from "./internal/control-panel";
export {
  type ControlPanelRowProps,
  type ControlPanelRowSelect,
  type ControlPanelRowIndicator,
  type ControlPanelRowTone,
} from "./internal/control-panel-row";
export { type ControlPanelRuleRowProps } from "./internal/rule-row";
export { type ControlPanelFieldProps } from "./internal/field-control";
export { type ControlPanelSettingProps } from "./internal/setting";
export { type ControlPanelBlockProps } from "./internal/block";
export { type ControlPanelSubheadProps } from "./internal/subhead";
export { type ControlPanelGroupProps } from "./internal/group";
export {
  type ControlPanelFit,
  type ControlPanelMark,
} from "./internal/setting-row";
export { useControlPanelHost, type ControlPanelHost } from "./internal/host";
export {
  ControlPanelPane,
  type ControlPanelPaneProps,
} from "./internal/control-panel-pane";

export default {
  description:
    "The control-panel vocabulary: ControlPanel plus its closed set of members (Section, Subhead, Row, Setting, Block, Group, RuleList, RuleRow, Field, Footer, Empty, Stack) and its two surfaces, ControlPanelPopover and ControlPanelPane. The container draws the hairlines, the row is a grid so every label starts at one x, selection has one language per meaning, and width is a role rather than a measurement.",
  contributions: [],
} satisfies PluginDefinition;
