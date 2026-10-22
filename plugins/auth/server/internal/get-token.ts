import type {
  GetAccessTokenArgs,
  TokenResponse,
} from "@plugins/auth/core";
import { getToken } from "@plugins/auth/core";
import { callEndpoint } from "@plugins/infra/plugins/endpoints/server";
import { EndpointError } from "@plugins/infra/plugins/endpoints/core";

/** Central's routes are served by the gateway on every host name. */
const CENTRAL_ORIGIN = "http://localhost:9000";
const RETRY_DELAY_MS = 250;

export class AuthCentralOfflineError extends Error {
  constructor() {
    super("Auth central runtime is unreachable");
    this.name = "AuthCentralOfflineError";
  }
}

export async function getTokenFromCentral(
  args: GetAccessTokenArgs,
): Promise<TokenResponse> {
  const send = () =>
    callEndpoint(getToken, {}, { origin: CENTRAL_ORIGIN, body: args });
  try {
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return await send();
    }
  } catch (err) {
    if (err instanceof TypeError) throw new AuthCentralOfflineError();
    if (
      err instanceof EndpointError &&
      (err.status === 502 || err.status === 503 || err.status === 504)
    ) {
      throw new AuthCentralOfflineError();
    }
    throw err;
  }
}
