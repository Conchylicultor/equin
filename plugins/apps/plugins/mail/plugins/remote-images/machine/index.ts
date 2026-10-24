import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { getMailImage } from "../core";
import { handleMailImage } from "./internal/handle-image";

export default {
  description:
    "SSRF-guarded, image-content-type-restricted proxy for remote email images (GET /api/mail/image?url=, needsMachine). Same-origin; fetches through safeFetch, refuses non-image responses (415), and only ever hit after the user opts into 'Display images' — so it is neither a tracking-pixel leak nor an open proxy.",
  httpRoutes: {
    [getMailImage.route]: machineHandler(getMailImage, handleMailImage),
  },
} satisfies MachinePluginDefinition;
