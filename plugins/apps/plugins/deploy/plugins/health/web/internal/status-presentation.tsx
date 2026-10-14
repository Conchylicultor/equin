import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { serverHealthShape } from "../../shared";
import {
  ServerStatusBadge,
  statusOfOk,
} from "../components/server-status-badge";

/**
 * How the exposed `status` field (the probe's `ok`) presents in every list of
 * servers: the status badge. The list names neither this plugin nor the field.
 */
export const serverStatusPresentation = FieldPresentation.Register({
  owner: serverHealthShape.exposure,
  fields: {
    ok: {
      cell: (ok) => <ServerStatusBadge status={statusOfOk(ok)} />,
      align: "end",
    },
  },
});
