import type { DataViewViewEdits } from "../../core";
import type { ViewEditsOptions } from "./use-data-view-model";

/** A surface's `viewEdits` prop as the model's options — one reading for
 *  `DataView` and `DataViewSwitcher`. Its own module, so a test mocking the
 *  model hook keeps it. */
export function viewEditsOptions(
  edits: DataViewViewEdits | undefined,
): ViewEditsOptions | undefined {
  if (edits === undefined) return undefined;
  return {
    drafts: edits.mode === "draft",
    ...(edits.home !== undefined ? { home: edits.home } : {}),
  };
}
