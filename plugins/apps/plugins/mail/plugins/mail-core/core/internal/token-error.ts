/**
 * No usable Gmail connection: the integration could not hand out an access
 * token (not connected, a revoked or expired grant). Typed so a caller tells
 * it apart by class — `instanceof`, never a match on the message wording.
 */
export class GmailTokenUnavailableError extends Error {
  constructor(reason: string) {
    super(`Gmail token unavailable: ${reason}`);
    this.name = "GmailTokenUnavailableError";
  }
}
