import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  Steps,
  Step,
  StepLink,
  StepDone,
  StepNote,
  StepCommand,
  StepActions,
  StepAction,
  StepKey,
  type StepProps,
  type StepState,
} from "./internal/steps";

export default {
  description:
    "Guided setup-flow primitive: <Steps> ordered container auto-numbering <Step> items (upcoming/active/done states, dimmed-and-inert future steps, check-on-done, connecting rail), plus StepLink (open-external), StepDone (success line), StepNote (muted hint) and StepCommand (copyable command row) affordances, and StepActions/StepAction/StepKey (a numbered click-path in full-contrast body text, with the exact UI labels emphasised).",
  contributions: [],
} satisfies PluginDefinition;
