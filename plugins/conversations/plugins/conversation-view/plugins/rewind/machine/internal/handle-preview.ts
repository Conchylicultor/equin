import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { previewRewind } from "@plugins/conversations/server";
import { previewRewindEndpoint } from "../../core/endpoints";

export const handlePreviewRewind = implementMachine(
  previewRewindEndpoint,
  ({ params, body }) => previewRewind(params.id, body.uuid),
);
