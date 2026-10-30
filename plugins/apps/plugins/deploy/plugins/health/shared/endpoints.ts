import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { SshCheckResultSchema } from "./schemas";

/**
 * Probe the server over SSH and record the verdict. Always answers with the
 * discriminated `SshCheckResult` for an SSH-layer outcome (a failed probe is a
 * successful request); 404 for an unknown server and 409 when no key is
 * configured yet are the only error statuses.
 */
export const checkServerSsh = defineEndpoint({
  route: "POST /api/deploy/servers/:id/ssh-check",
  response: SshCheckResultSchema,
});

/**
 * Drop the TOFU-pinned known_hosts line so a legitimately reinstalled server
 * can be re-trusted. Deliberately an explicit user action: a host-key mismatch
 * is either a reinstall or a man-in-the-middle, and only the user knows which.
 */
export const forgetServerHostKey = defineEndpoint({
  route: "POST /api/deploy/servers/:id/forget-host-key",
});
