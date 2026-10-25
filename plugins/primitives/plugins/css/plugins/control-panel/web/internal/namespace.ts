import {
  ControlPanel as ControlPanelRoot,
  ControlPanelEmpty,
  ControlPanelFooter,
  ControlPanelRuleList,
  ControlPanelSection,
} from "./control-panel";
import { ControlPanelRow } from "./control-panel-row";
import { ControlPanelBlock } from "./block";
import { ControlPanelField } from "./field-control";
import { ControlPanelGroup } from "./group";
import { ControlPanelLabelMark } from "./label-mark";
import { ControlPanelStack } from "./panel-stack";
import { ControlPanelRuleRow } from "./rule-row";
import { ControlPanelSetting } from "./setting";
import { ControlPanelSubhead } from "./subhead";

/**
 * The vocabulary, as ONE compound namespace.
 *
 * Read as a set, the four ways to be ONE FIELD sit next to each other: `Row`
 * (the row IS the control), `Setting` (the row HOLDS the control), `Block` (the
 * control is wider than a row) and `Group` (the field is other fields) — plus
 * the builder pair, plus the boxes and bands, plus `Subhead`, which names a RUN
 * of rows rather than any one field and so sits beside `Section` rather than
 * among the four — plus `LabelMark`, a mark a host asks every row label under
 * it to draw.
 *
 * That shape is the API's main affordance: typing `ControlPanel.` shows the
 * author the whole closed set at the point of writing, and says there is no
 * further thing. It is also why `control-panel` is one plugin rather than an
 * umbrella of small ones — attaching members exported by sibling plugins onto a
 * single object is a cross-plugin re-export in all but syntax, which the
 * boundary checker rejects transitively. (`switch` is genuinely reusable outside
 * panels and has no namespace tie, so it IS its own plugin.)
 */
export const ControlPanel = Object.assign(ControlPanelRoot, {
  Section: ControlPanelSection,
  Subhead: ControlPanelSubhead,
  Row: ControlPanelRow,
  Setting: ControlPanelSetting,
  Block: ControlPanelBlock,
  Group: ControlPanelGroup,
  RuleList: ControlPanelRuleList,
  RuleRow: ControlPanelRuleRow,
  Field: ControlPanelField,
  Footer: ControlPanelFooter,
  Empty: ControlPanelEmpty,
  Stack: ControlPanelStack,
  LabelMark: ControlPanelLabelMark,
});
