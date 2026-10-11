import { describe, expect, it } from "bun:test";
import { pageZeroParams } from "@plugins/network/plugins/live/web/testing";
import { conversationsGone } from "../../core/resources";

// `conversationsGone` is preloaded at boot and read both plainly (the done
// count, the recovery view) and as key-range pages (the Queue's Done
// section): the pages' first tuple must be the one the boot snapshot
// hydrated, or the paged read loads it again on every page load.
describe("conversationsGone — the paged read's first page", () => {
  it("is the boot-hydrated default tuple", () => {
    expect(pageZeroParams(conversationsGone)).toEqual(
      conversationsGone.window.defaultParams,
    );
  });
});
