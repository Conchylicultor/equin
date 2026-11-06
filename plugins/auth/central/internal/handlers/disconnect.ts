import { implementCentral } from "@plugins/infra/plugins/endpoints/central";
import { disconnect } from "@plugins/auth/core";
import { disconnectAccount } from "../actions";

/** POST /api/auth/disconnect/:provider */
export const handleDisconnect = implementCentral(
  disconnect,
  async ({ params, body }) => {
    await disconnectAccount(params.provider, body.accountId);
  },
);
