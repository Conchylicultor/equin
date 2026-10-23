import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { ugAlignmentShape } from "../../core";

/**
 * The Video field of every list of songs — the recording a UG song is aligned
 * to (`ugAlignmentShape`'s exposed `videoId`). The cover already shows it, so
 * the body leaves it out by default; a user can switch it on (or filter on
 * "has a video").
 */
export const ugVideoPresentation = FieldPresentation.Register({
  owner: ugAlignmentShape.exposure,
  fields: {
    videoId: { visible: false, icon: symbol("smart-display") },
  },
});
