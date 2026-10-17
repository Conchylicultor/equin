import { useState, type ReactNode } from "react";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { hoverRevealTarget } from "@plugins/primitives/plugins/hover-reveal/web";
import type { ToolbarPartForms } from "../../../core";
import type { DataViewControl } from "../../slots";
import { useDataViewControls } from "../controls/controls-context";
import { DataViewControlPanel } from "./control-panel-host";
import { ROUND_AT_REST } from "./round-form";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const tuneIcon = symbol("tune");

/**
 * The narrow-toolbar fold. One `MdTune` trigger (ghost, or `secondary` + count
 * badge when anything is active) opens a panel whose first page is the search
 * field and one row per control — each showing what that control is currently
 * doing, and opening it as a PAGE.
 *
 * **There are no nested popovers.** The fold used to lay out `[label]
 * [icon-button]` rows made of the wide bar's own triggers, so opening the filter
 * from a narrow toolbar meant a popover inside a popover: a second floating
 * layer, its own width, its own clamp, its own dismissal — over a surface that
 * was narrow to begin with. A push is the same box at every depth.
 *
 * Wide and compact share one code path: both mount `DataViewControlPanel`, which
 * is prop-less and reads `useDataViewControls()`. The wide layout puts it in a
 * popover, this one puts it in a stack entry, and there is nothing left for them
 * to diverge on.
 *
 * **The trigger is hover-revealed**, off the group the TOOLBAR ROW publishes —
 * so a surface at rest shows only its data, and pointing at the bar brings the
 * trigger back. The anchor is the bar and not the DataView root because the
 * trigger belongs to the bar: keyed on the root, grazing any row on the way
 * somewhere else flickered a control in the far top corner, unconnected to
 * anything the user was doing. Note this is the ONE fold: it applies
 * wherever the compact form appears, so the surfaces that already folded by
 * measurement — the agent-manager conversations sidebar and every other narrow
 * DataView — get the revealed trigger too. One fold, one behaviour; a
 * declaration-only reveal would mean two visually different compact bars whose
 * difference nothing in the UI explains.
 */
export function CompactControls({
  controls,
  activeCount,
  searching,
  search,
  revealOnHover = true,
  form = "ghost",
}: {
  /** The applicable controls, in order — the same list the wide bar renders. */
  controls: DataViewControl[];
  /** Σ of each control's summary count, plus one for a non-empty query. */
  activeCount: number;
  /** Whether the search query is non-empty — see `alwaysVisible`. */
  searching: boolean;
  /** The search field, rendered full-width at the top of the first page. */
  search?: ReactNode;
  /**
   * `false` keeps the trigger visible at rest. The compact fold hides it until
   * the bar is pointed at (below); an arrangement that folds its controls to
   * save room — not to quiet the bar — shows it like any other control.
   */
  revealOnHover?: boolean;
  /** The trigger's shape — the arrangement's `forms.controls`. */
  form?: ToolbarPartForms["controls"];
}): ReactNode {
  const [open, setOpen] = useState(false);
  if (controls.length === 0 && !search) return null;
  const active = activeCount > 0;
  // The reveal is suspended in exactly two cases:
  //
  // - `searching` — there is a query in the search field. A query is an ad-hoc
  //   gesture: it is typed, it narrows the list, and once the bar is folded away
  //   it leaves no other trace on screen — so the list reads as the view's whole
  //   contents when it is not. That is why the query lives in per-tab
  //   `sessionStorage` in the first place — the DataView CLAUDE.md's "State
  //   split" section calls it a gesture "that outlives its intent if it survives
  //   a browser restart" — and this reveal rule is downstream of exactly that
  //   split. The trigger is what the user follows back to the query they forgot
  //   they typed.
  // - `open` — its own panel is up. The panel is portaled, so the pointer leaves
  //   the hover group the instant it moves into it; without this the trigger
  //   would fade out from under the panel it opened.
  //
  // Note what is NOT here: filter, sort and group-by — nor `activeCount`, which
  // counts them. Those are the *durable* half of the same split. They live on
  // the view instance's config row: authored, persisted, git-promotable, part of
  // what that named view IS. A view called "Failed builds" is not a list hiding
  // things from you, it is that list, and it has nothing to confess — pinning
  // its trigger open forever would be reporting its own definition back to it as
  // if it were an accident. (The first attempt at this rule did pin on
  // `activeCount`, and since surfaces author a default sort in config, the
  // trigger never hid at all.) The badge still counts them, which is a different
  // and correct statement: "N things configured" is worth reading once you have
  // pointed at the surface.
  const alwaysVisible = !revealOnHover || open || searching;
  // Applied to whichever form the trigger takes: the `secondary` + badge form is
  // hover-revealed too, since a badge reporting a config-authored filter or sort
  // is precisely the at-rest state this hides.
  const revealClass = alwaysVisible ? undefined : hoverRevealTarget;
  const shape = form === "round" ? "pill" : "default";

  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      align="end"
      // No width: the root page is a search field and one row per control — a
      // list of choices, so it opens menu-wide. A pushed page is as wide as its
      // content declares: filter and sort widen to `builder` because their
      // rule rows (and their empty field pickers) say so; settings declares
      // nothing and keeps `menu`, the width it opens at on its own trigger.
      label="View options"
      // Idle it is an `IconButton`, which carries the tooltip — the popover has
      // no `tooltip` prop of its own, by design: the trigger owns it, and a
      // second source for the same string is how the two drift.
      // The reveal class goes on the trigger ELEMENT, never on a wrapper:
      // `ControlPanelPopover` hands this element to base-ui's `render` prop, so
      // the element itself IS the popover's anchor — an extra `<span>` around it
      // would become the anchor instead and position the panel against a box
      // that is not the button.
      trigger={
        active ? (
          <Button
            variant="secondary"
            aspect="text"
            aria-label="View options"
            shape={shape}
            className={revealClass}
          >
            <Icon icon={tuneIcon} />
            <span className="tabular-nums">{activeCount}</span>
          </Button>
        ) : (
          <IconButton
            icon={tuneIcon}
            label="View options"
            variant="ghost"
            shape={shape}
            className={cn(revealClass, form === "round" && ROUND_AT_REST)}
          />
        )
      }
    >
      <CompactRootPanel controls={controls} search={search} />
    </ControlPanelPopover>
  );
}

/**
 * The fold's first page. Its rows push their control's page (`Row push`), which
 * needs the stack the popover mounts.
 * Also the head of a sections surface's per-section `⋯` panel
 * (`view-section.tsx`), so a section's controls read exactly like the fold's.
 */
export function CompactRootPanel({
  controls,
  search,
}: {
  controls: DataViewControl[];
  search?: ReactNode;
}): ReactNode {
  const ctx = useDataViewControls();

  return (
    <>
      {search ? <ControlPanel.Section>{search}</ControlPanel.Section> : null}
      <ControlPanel.Section>
        {controls.map((control) => {
          // The same pure `summary` the wide bar's trigger reads — so a folded
          // control says exactly what its unfolded twin would say.
          const summary = control.summary?.(ctx) ?? null;
          return (
            <ControlPanel.Row
              key={control.id}
              icon={<Icon icon={control.icon} />}
              trailing={
                summary
                  ? summary.more
                    ? `${summary.label} +${summary.more}`
                    : summary.label
                  : undefined
              }
              push={{
                key: control.id,
                title: control.label,
                render: () => <DataViewControlPanel control={control} />,
              }}
            >
              {control.label}
            </ControlPanel.Row>
          );
        })}
      </ControlPanel.Section>
    </>
  );
}
