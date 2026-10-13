/**
 * The gallery drawing a paged read: the stacked contract (one placeholder
 * exactly as tall as the released lines, no scroll written, a landing
 * anchored), plus a page ending mid-line keeping every card's column — plain
 * and windowed — and a windowed release keeping the mounted lines. Run against
 * the real body on a laid-out page by data-view's shared suite
 * (`describePagedConformance`, `data-view/web/testing`).
 *
 * Run: `./singularity test plugins/primitives/plugins/data-view/plugins/gallery`.
 */

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { describePagedConformance } from "@plugins/primitives/plugins/data-view/web/testing";
import { GalleryView } from "../components/gallery-view";

afterEach(cleanup);

describePagedConformance({
  view: { type: "gallery", component: GalleryView },
  layout: { columns: 4, linePx: 100 },
  windowAbove: 60,
});
