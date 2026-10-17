import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type React from "react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { ControlPanelSection } from "./control-panel";
import { ControlPanelRow } from "./control-panel-row";
import { GroupDepthProvider, useControlPanelHost, useGroupDepth } from "./host";
import { usePanelStack } from "./stack-context";
import {
  SettingDescription,
  SettingNote,
  SettingRow,
  type ControlPanelMark,
} from "./setting-row";

export interface ControlPanelGroupProps {
  label: React.ReactNode;
  hint?: string;
  description?: React.ReactNode;
  /**
   * Trailing summary when the group presents as a drill row — "3 items", a
   * variant name, a type. Ignored when the host inlines the group, which shows
   * the contents instead of summarizing them.
   */
  summary?: React.ReactNode;
  /** Presentational, in flow — a count, a state chip. */
  status?: React.ReactNode;
  /**
   * Hover-revealed cluster on the group's HEADER — a reset, a remove.
   *
   * Honoured only when the host INLINES, because only then is the header a plain
   * `<div>` (the same `SettingRow` a `Setting` is built from). Under `push` the
   * group is a drill row, i.e. a `<button>`, and an action inside it would be a
   * nested interactive whose failure is silent. Rather than drop it there, the
   * group THROWS — the same policy `useControlPanelHost()` itself takes, and for
   * the same reason: a silently swallowed reset button is a bug nobody finds.
   */
  actions?: React.ReactNode;
  /** Chrome-gutter stripe on the header. Same host rule as `actions`. */
  mark?: ControlPanelMark;
  /** A line under the header, on the rail. Same host rule as `actions`. */
  note?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  // NO `mode` prop. The presentation belongs to the HOST, not to the field: a
  // popover pushes, a pane has no obvious stack, and a field that spelled the
  // choice at its call site would spell it wrong in whichever surface it was not
  // written for.
}

/**
 * A FIELD THAT IS OTHER FIELDS — an object, a list, a variant. The fourth way to
 * be one field, after `Row` (the row IS the control), `Setting` (the row HOLDS
 * the control) and `Block` (the control is wider than a row).
 *
 * How it presents is the HOST's answer, read from `useControlPanelHost()`:
 *
 *  - `nesting: "push"` — a drill row that pushes a panel-stack entry. Right for
 *    a popover, where `usePanelStack().push` replaces the whole body: one box,
 *    one width and one set of rails at every depth, instead of a popover opened
 *    from inside a popover.
 *  - `nesting: "inline"` — an indented labelled band, down to the host's
 *    `inlineDepth`. Right for a pane, where replacing the whole body to edit one
 *    sub-object of fifteen loses the reader their place. Below the budget it
 *    pushes anyway, so a list-of-objects-of-lists still has somewhere to go.
 *
 * The indent is a NESTED RAIL REGION (`cp-group`), never a margin and never a
 * `border-l` + `pl-lg`: the group re-declares the rail one step deeper and pays
 * it, so a nested row's bleed reaches the group's edge and everything inside
 * behaves exactly as it does at panel level, one step in.
 */
export function ControlPanelGroup({
  label,
  hint,
  description,
  summary,
  status,
  actions,
  mark,
  note,
  children,
  className,
}: ControlPanelGroupProps) {
  const host = useControlPanelHost();
  const depth = useGroupDepth();
  const key = useId();
  // The node of this group's pushed level, while it is on the stack. The page is
  // PORTALED into it from here rather than rendered by the stack, so it is this
  // render's children — never a snapshot of the ones the group had when it was
  // pushed — and it keeps every context this group sits in.
  const [page, setPage] = useState<HTMLElement | null>(null);
  // A group that goes away takes its page with it: removing a list item from
  // inside its own page returns the user to the list, instead of leaving them
  // on a page about an item that no longer exists. Unconditional (both hosts
  // publish a stack, and the inline arm still pushes past its depth budget).
  const { close } = usePanelStack();
  useEffect(() => () => close(key), [close, key]);

  const inline = host.nesting === "inline" && depth < host.inlineDepth;
  if (!inline) {
    if (actions != null || mark != null || note != null) {
      throw new Error(
        "ControlPanel.Group: `actions` / `mark` / `note` are honoured only by a " +
          "host that inlines. This group is a drill row — a <button> — where an " +
          "action would be a nested interactive and a stripe would paint on a " +
          "different box. Adorn the members the group CONTAINS instead.",
      );
    }
    return (
      <>
        {/* The drill row pushes through `Row push`, which draws the chevron that
            says it drills. */}
        <ControlPanelRow
          push={{
            key,
            title: typeof label === "string" ? label : "",
            render: () => <div ref={setPage} style={{ display: "contents" }} />,
          }}
          trailing={
            <>
              {status}
              {summary}
            </>
          }
          className={className}
        >
          {label}
        </ControlPanelRow>
        {page
          ? createPortal(
              // A pushed page is a fresh panel body: its groups get the host's
              // whole inline budget again, as they did when the stack rendered it.
              <GroupDepthProvider depth={0}>
                <ControlPanelSection>{children}</ControlPanelSection>
              </GroupDepthProvider>,
              page,
            )
          : null}
      </>
    );
  }

  return (
    <>
      <SettingRow
        label={label}
        hint={hint}
        status={status}
        actions={actions}
        mark={mark}
      />
      {description != null ? (
        <SettingDescription>{description}</SettingDescription>
      ) : null}
      {/* Under the HEADER, not after the children: the note is about the group's
          own value, and hung below a nested region it would read as belonging to
          whatever field happened to be last inside it. */}
      {note != null ? <SettingNote>{note}</SettingNote> : null}
      <div data-inline className={cn("cp-group", className)}>
        <GroupDepthProvider depth={depth + 1}>{children}</GroupDepthProvider>
      </div>
    </>
  );
}
