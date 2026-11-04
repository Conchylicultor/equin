import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { VideoIdSchema } from "@plugins/integrations/plugins/youtube/core";
import {
  getBeatFeaturesEndpoint,
  requestBeatFeaturesEndpoint,
} from "../../core";
import { requestBeatFeatures } from "./job";
import { readBeatFeatures } from "./state";

function videoId(raw: string): string {
  const parsed = VideoIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, `not a YouTube video id: ${JSON.stringify(raw)}`);
  }
  return parsed.data;
}

export const handleGetBeatFeatures = implementMachine(
  getBeatFeaturesEndpoint,
  async ({ params }) => readBeatFeatures(videoId(params.videoId)),
);

export const handleRequestBeatFeatures = implementMachine(
  requestBeatFeaturesEndpoint,
  async ({ params, body }) =>
    requestBeatFeatures(videoId(params.videoId), { force: body.force }),
);
