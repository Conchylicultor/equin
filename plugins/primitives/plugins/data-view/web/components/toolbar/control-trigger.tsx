import { useState, type ReactNode } from "react";
import { ControlPanelPopover } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { dataPart, type ToolbarPartForms } from "../../../core";
import { ROUND_AT_REST } from "./round-form";
import type { DataViewControlAction } from "../../slots";
import type { ToolbarControl, ToolbarPanel } from "./use-toolbar-controls";

/**
 * ONE trigger for every toolbar control — there is no branch on which control it
 * is drawing. The toolbar used to hand-roll a `*BuilderTrigger` per control, each
 * with its own popover width and its own idea of what "active" looks like; the
 * only thing they actually differed in was an icon and a word.
 *
 * **It is icon-only, in every surface and at every width.** A ghost `IconButton`
 * at rest; `secondary` once the control is narrowing what you see. Nothing else
 * changes — no summary text on the button, no `+N` badge, and above all no
 * width-dependent form. A control that reads one way in a wide pane and another
 * way in a sidebar is the inconsistency this whole registry exists to remove, and
 * the toolbar's one line is the scarcest space in the app — in the agent-manager
 * sidebar, two summary pills consumed the whole bar.
 *
 * **The summary is still what the closed state says — in words, not in pixels.**
 * `control.summary(ctx)` feeds the accessible name and the tooltip, so hovering an
 * active Filter tells you "Filter: Status is none of 2 +1" and a screen reader is
 * told the same thing without ever opening the panel. `spoken` is the arm for a
 * label leaning on a glyph ("Updated ↓" reads as nothing aloud), and `+N` is
 * spelled out there because a bare number beside a phrase is ambiguous with no
 * visual context. The compact fold spends the same summary as visible text, on
 * rows that have room for it.
 */
export function ControlTrigger({
  control,
  form = "ghost",
}: {
  control: ToolbarControl;
  /** The trigger's shape — the arrangement's `forms.controls`. */
  form?: ToolbarPartForms["controls"];
}): ReactNode {
  return control.kind === "panel" ? (
    <PanelTrigger panel={control.panel} form={form} />
  ) : (
    <ActionTrigger action={control.action} form={form} />
  );
}

/**
 * An action control's trigger: the same ghost `IconButton` as a panel's, but
 * it acts on click instead of opening a panel. Its label (tooltip + accessible
 * name) and glyph are the action's current ones — "Expand all" ⇄ "Collapse
 * all" — and it is never `secondary`: an action narrows nothing.
 */
function ActionTrigger({
  action,
  form,
}: {
  action: DataViewControlAction;
  form: ToolbarPartForms["controls"];
}): ReactNode {
  return (
    <IconButton
      icon={action.icon}
      label={action.label}
      tooltip={action.label}
      variant="ghost"
      shape={form === "round" ? "pill" : "default"}
      className={cn(form === "round" && ROUND_AT_REST)}
      onClick={action.run}
      {...dataPart("dv.control")}
    />
  );
}

function PanelTrigger({
  panel,
  form,
}: {
  panel: ToolbarPanel;
  /**
   * The trigger's shape — the arrangement's `forms.controls`. `round` is the
   * same icon button drawn as a circle (a pill with no label), whose glyph
   * rests in the faint text tier and lifts to the text colour on hover.
   */
  form: ToolbarPartForms["controls"];
}): ReactNode {
  const [open, setOpen] = useState(false);
  // Pure — no panel is mounted to compute it (`useToolbarControls`).
  const { summary } = panel;
  // `secondary` only while it narrows what you see — a promoted setting
  // (configuration) says what it is set to in words only.
  const active = summary !== null && panel.narrows;

  const suffix = summary?.more ?? 0;
  const label = summary
    ? `${panel.label}: ${summary.spoken ?? summary.label}` +
      (suffix ? `, +${suffix} more` : "")
    : panel.label;
  const tooltip = summary
    ? `${panel.label}: ${summary.label}` + (suffix ? ` +${suffix}` : "")
    : panel.label;

  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label={panel.label}
      trigger={
        <IconButton
          icon={panel.icon}
          label={label}
          tooltip={tooltip}
          variant={active ? "secondary" : "ghost"}
          shape={form === "round" ? "pill" : "default"}
          className={cn(form === "round" && !active && ROUND_AT_REST)}
          {...dataPart("dv.control")}
        />
      }
    >
      {panel.render()}
    </ControlPanelPopover>
  );
}
