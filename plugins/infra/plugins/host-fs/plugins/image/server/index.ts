import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { resizedImagesDir } from "../data-dirs";
import { hostFsImageResized } from "../core";
import { makeResizedHandler } from "./internal/resize";
import { resizedImagesSweepJob } from "./internal/sweep-job";

export default {
  description:
    "Images on the host filesystem: GET resized (a copy with a long edge from a closed set, EXIF-rotated, never enlarged — JPEG, or WebP with transparency — made with sharp, cached host-wide and served immutable for the file version the URL names; 415 when undecodable). The daily host-fs-image.sweep keeps the cache within 30 days unused and 1 GB.",
  httpRoutes: {
    [hostFsImageResized.route]: makeResizedHandler(() => resizedImagesDir.path),
  },
  register: [resizedImagesSweepJob],
} satisfies ServerPluginDefinition;
