import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { checkUpstreamEndpoint } from "@plugins/upstream/plugins/release/core";
import { checkUpstream } from "./release-status";

/** `POST /api/upstream/check`: the daily job's check, now. */
export const handleCheckUpstream = implementMachine(
  checkUpstreamEndpoint,
  async () => {
    const status = await checkUpstream();
    return status.kind === "unreachable"
      ? { kind: "unreachable", detail: status.detail }
      : { kind: "checked" };
  },
);
