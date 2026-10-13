/**
 * The list view drawing a paged read: a released page is one placeholder
 * exactly as tall as its rows, a release writes no scroll, and a landing that
 * changed size above the reader is anchored. Run against the real body on a
 * laid-out page by data-view's shared suite (`describePagedConformance`, `data-
 * view/web/testing`).
 *
 * Run: `./singularity test plugins/primitives/plugins/data-view/plugins/list`.
 */

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { describePagedConformance } from "@plugins/primitives/plugins/data-view/web/testing";
import { ListView } from "../components/list-view";

afterEach(cleanup);

describePagedConformance({
  view: { type: "list", component: ListView },
  layout: "stack",
});
