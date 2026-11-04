import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { ugTabSaved } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/server";
import {
  cancelUgAlignment,
  realignUg,
  refuseUgAlignmentVideo,
  resolveUgAlignment,
  setUgAlignmentVideo,
} from "../core";
import { ugAlignJob } from "./internal/job";
import { onUgTabSavedJob } from "./internal/on-tab-saved-job";
import {
  handleCancelUgAlignment,
  handleRealignUg,
  handleRefuseUgAlignmentVideo,
  handleResolveUgAlignment,
  handleSetUgAlignmentVideo,
} from "./internal/routes";

export default {
  description:
    "UG sheet alignment, desktop half (needsMachine: it downloads a recording and analyses its audio on this computer): the sonata.ug-alignment.align supervised job (choose a video with findSongVideos and walk the best candidates when none was set; beat features → alignChords → record, its live phase written on the row; a user's Cancel stops it as cancelled), the set-video / find-a-video / video-refused / re-align (also resuming a cancelled or failed walk) / cancel endpoints, and a trigger that starts choosing a video for a new UG song and re-aligns one whose sheet changes.",
  register: [ugAlignJob, onUgTabSavedJob],
  contributions: [
    // Choose a video for a new song, re-align on every sheet save. Match-any
    // on songId — the saved song reaches the job through the event payload.
    Trigger({ on: ugTabSaved, do: onUgTabSavedJob, with: {}, oneShot: false }),
  ],
  httpRoutes: {
    [setUgAlignmentVideo.route]: handleSetUgAlignmentVideo,
    [realignUg.route]: handleRealignUg,
    [resolveUgAlignment.route]: handleResolveUgAlignment,
    [refuseUgAlignmentVideo.route]: handleRefuseUgAlignmentVideo,
    [cancelUgAlignment.route]: handleCancelUgAlignment,
  },
} satisfies MachinePluginDefinition;
