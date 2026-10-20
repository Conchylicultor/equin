import { defineRootSlot } from "@plugins/framework/plugins/web-sdk/core";

export const WebStorageSlots = {
  /**
   * App-wide headless listeners storage failures need (the toast, the reports
   * collector). Companions: they ship wherever web-storage does, since nothing
   * imports them.
   */
  Root: defineRootSlot(),
};
