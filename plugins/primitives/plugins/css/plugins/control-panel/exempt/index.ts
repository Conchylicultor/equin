import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "control-panel/no-adhoc-panel-body",
    paths: ["web/internal/control-panel-popover.tsx"],
    kind: "sanctioned",
    reason:
      'The file that builds the sanctioned host: ControlPanelPopover is the one place a `<ControlPanel>` under a `PopoverContent` is correct, because it is where `padding="none"` is set. A rule that redirects to a component must not police the component.',
  },
  {
    rule: "control-panel/no-adhoc-panel-body",
    paths: ["web/internal/control-panel-card.tsx"],
    kind: "sanctioned",
    reason:
      'The other sanctioned host: ControlPanelCard builds the settings-card surface, a `<ControlPanel>` under a `PopoverContent` with `padding="none"` and the card inset (`cp-card`). A rule that redirects to a component must not police the component.',
  },
] satisfies Exemptions;
