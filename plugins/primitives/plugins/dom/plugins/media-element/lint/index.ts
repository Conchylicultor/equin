import noRawMediaPlay from "./no-raw-media-play";
import noRawRequestPictureInPicture from "./no-raw-request-picture-in-picture";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "media-element",
  rules: {
    "no-raw-media-play": noRawMediaPlay,
    "no-raw-request-picture-in-picture": noRawRequestPictureInPicture,
  },
} satisfies LintContribution;
