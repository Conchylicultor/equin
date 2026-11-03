import type { ReactNode } from "react";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { FieldsRecord } from "@plugins/fields/core";
import {
  getDataViewDescriptor,
  useDataViewControls,
  type DataViewId,
} from "@plugins/primitives/plugins/data-view/web";
import { useCustomColumnDefs } from "../internal/use-custom-column-defs";
import { CustomColumnsFields } from "./data-view-settings-button";

/**
 * The custom-columns "Fields" UI as a real `DataViewSlots.Setting` contribution
 * (`scope: "global"`) — the dependency-inversion end state. It reads the surface's
 * `storageKey` from the controls context, resolves the SAME reference-stable
 * config descriptor the host registered (via `getDataViewDescriptor`), drives the
 * definitions controller, and renders the content-only `CustomColumnsFields`
 * section. The host now names no individual setting — custom-columns contributes
 * itself like every other setting, error-boundary-isolated in the menu.
 *
 * Renders nothing for a storageKey with no registered descriptor (mirrors the old
 * host `descriptor != null` gate). The `useCustomColumnDefs` hook lives in an
 * inner component mounted only past that gate, so it is never called conditionally
 * (`storageKey` is stable per surface → the gate is hook-order-stable).
 */
export function CustomColumnsFieldsSetting(): ReactNode {
  const { storageKey, customColumns } = useDataViewControls();
  const descriptor = getDataViewDescriptor(storageKey);
  if (!descriptor) return null;
  return (
    <Fields
      descriptor={descriptor}
      storageKey={storageKey}
      // Under a live source that takes no column scope, the columns still
      // show and edit — but never sort or filter the list: said here, with
      // the source's own reason, rather than discovered as a missing option.
      unsortedBecause={
        customColumns.kind === "unscoped" ? customColumns.reason : null
      }
    />
  );
}

function Fields({
  descriptor,
  storageKey,
  unsortedBecause,
}: {
  descriptor: ConfigDescriptor<FieldsRecord>;
  storageKey: DataViewId;
  unsortedBecause: string | null;
}): ReactNode {
  const { defs } = useCustomColumnDefs(descriptor, storageKey);
  return <CustomColumnsFields defs={defs} unsortedBecause={unsortedBecause} />;
}
