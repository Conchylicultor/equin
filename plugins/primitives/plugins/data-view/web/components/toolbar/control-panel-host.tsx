import type { ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import { DataViewSlots, type DataViewPanelControl } from "../../slots";

/**
 * Mounts ONE control's panel body, error-boundary-isolated.
 *
 * It is a component of its own — a one-line one, at that — because it is the
 * single place both toolbar layouts mount a panel. The wide layout renders it
 * inside a `ControlPanelPopover`; the compact fold renders it as a stack entry.
 * Since the panel component is prop-less and reads `useDataViewControls()`, the
 * two call sites are byte-identical, and there is nothing left for them to
 * diverge on — which is the whole reason the filter and sort panels used to be
 * described as "byte-for-byte identical in either layout" in a comment rather
 * than by construction.
 */
export function DataViewControlPanel({
  control,
}: {
  control: DataViewPanelControl;
}): ReactNode {
  return renderIsolated(
    DataViewSlots.Control,
    control as unknown as Contribution,
    {},
  );
}
