import { defineDataViewSources } from "@plugins/primitives/plugins/data-view/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";

/** What the Reports pane hands each of its sources: the selection and where a row goes. */
export interface ReportsHostProps {
  selectedId: string | undefined;
  /** Where a row goes: a link, so middle- / ⌘-click open it in a browser tab. */
  linkTo: (id: string) => LinkTarget;
}

/**
 * The Reports pane's sources: one view bar over the same reports, sliced by
 * where they stand against their fix — the Worklist (open ∪ regressed, what a
 * supervisor works from), Regressed, Fix pending, Fixed and All.
 */
export const ReportsSources = defineDataViewSources<ReportsHostProps>();
