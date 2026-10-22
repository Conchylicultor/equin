import { getGmailToken } from "@plugins/integrations/plugins/gmail/server";
import { GmailTokenUnavailableError } from "../../core";

/** A usable Gmail connection: the access token plus the connected account email
 *  (from the OAuth identity, known without a Gmail API call). */
export interface GmailConnection {
  accessToken: string;
  email: string | null;
}

/** Resolve a usable Gmail connection or fail loudly. The mail data layer's
 *  single entry point for Gmail auth — it goes through the gmail integration,
 *  never @plugins/auth directly. Returning the account email lets bootstrap
 *  create the account row *before* the first Gmail API call, so a bootstrap-time
 *  API failure has a real row to attach its classified error to. */
export async function requireGmailToken(): Promise<GmailConnection> {
  const result = await getGmailToken();
  if (!result.ok) throw new GmailTokenUnavailableError(result.message);
  return { accessToken: result.accessToken, email: result.email };
}
