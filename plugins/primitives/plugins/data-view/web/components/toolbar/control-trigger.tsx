import { useState, type ReactNode } from "react";
import { ControlPanelPopover } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ToolbarPartForms } from "../../../core";
import { ROUND_AT_REST } from "./round-form";
import type { DataViewControl } from "../../slots";
import { useDataViewControls } from "../controls/controls-context";
import { DataViewControlPanel } from "./control-panel-host";

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
  control: DataViewControl;
  /**
   * The trigger's shape — the arrangement's `forms.controls`. `round` is the
   * same icon button drawn as a circle (a pill with no label), whose glyph
   * rests in the faint text tier and lifts to the text colour on hover.
   */
  form?: ToolbarPartForms["controls"];
}): ReactNode {
  const ctx = useDataViewControls();
  const [open, setOpen] = useState(false);
  // Pure — no panel is mounted to compute it. See `DataViewControlContribution`.
  const summary = control.summary?.(ctx) ?? null;

  const suffix = summary?.more ?? 0;
  const label = summary
    ? `${control.label}: ${summary.spoken ?? summary.label}` +
      (suffix ? `, +${suffix} more` : "")
    : control.label;
  const tooltip = summary
    ? `${control.label}: ${summary.label}` + (suffix ? ` +${suffix}` : "")
    : control.label;

  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label={control.label}
      trigger={
        <IconButton
          icon={control.icon}
          label={label}
          tooltip={tooltip}
          variant={summary ? "secondary" : "ghost"}
          shape={form === "round" ? "pill" : "default"}
          className={cn(form === "round" && !summary && ROUND_AT_REST)}
        />
      }
    >
      <DataViewControlPanel control={control} />
    </ControlPanelPopover>
  );
}
