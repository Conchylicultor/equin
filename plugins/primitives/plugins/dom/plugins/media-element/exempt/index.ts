import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "media-element/no-raw-media-play",
    paths: ["web/internal/media-play.ts"],
    kind: "sanctioned",
    reason:
      "The primitive's one play(), whose every rejection playMedia names.",
  },
  {
    rule: "media-element/no-raw-request-picture-in-picture",
    paths: ["web/internal/video-pip.ts"],
    kind: "sanctioned",
    reason:
      "The primitive's one request, reachable only from the supported arm of videoPipSupport(doc).",
  },
] satisfies Exemptions;
