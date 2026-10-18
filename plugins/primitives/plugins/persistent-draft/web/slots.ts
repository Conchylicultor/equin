import { defineRootSlot } from "@plugins/framework/plugins/web-sdk/core";

export const DraftSlots = {
  /**
   * App-wide headless listeners drafts need (the unsaved-draft warning).
   * Companions: they ship wherever persistent-draft does, since nothing
   * imports them.
   */
  Root: defineRootSlot(),
};
