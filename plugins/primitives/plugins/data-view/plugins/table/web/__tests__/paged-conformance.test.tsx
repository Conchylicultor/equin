/**
 * The table view drawing a paged read (ungrouped — a grouped table draws a
 * declared section's placeholders after its rows only, see the table's
 * CLAUDE.md): a released page is one placeholder exactly as tall as its rows, a
 * release writes no scroll, and a landing that changed size above the reader is
 * anchored. Run against the real body on a laid-out page by data-view's shared
 * suite (`describePagedConformance`, `data-view/web/testing`).
 *
 * Run: `./singularity test plugins/primitives/plugins/data-view/plugins/table`.
 */

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { describePagedConformance } from "@plugins/primitives/plugins/data-view/web/testing";
import { TableView } from "../components/table-view";

afterEach(cleanup);

describePagedConformance({
  view: { type: "table", component: TableView },
  layout: "stack",
});
