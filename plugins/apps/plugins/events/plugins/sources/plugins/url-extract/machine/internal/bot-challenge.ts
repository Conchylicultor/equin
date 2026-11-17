import type { BotMitigation } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/core";

/**
 * "This site refuses automated readers, and we have already tried the one thing
 * that could change that."
 *
 * A distinct class rather than a message, because it is the only failure in this
 * plugin whose *terminality* comes from the site's standing policy rather than
 * from the moment: `classify-error.ts` maps it to `bot_challenge` and parks the
 * source, so graphile stops re-asking a question that has one permanent answer.
 *
 * ## Why not `extends NonRetryableError`
 *
 * Three reasons, and the first two are mechanical, not stylistic:
 *
 * 1. `NonRetryableError`'s constructor sets `this.name = "NonRetryableError"`,
 *    so a subclass either inherits the wrong name or fights the base for it —
 *    and the name IS the cross-plugin contract `classify-error.ts` matches on.
 * 2. `NonRetryableError` carries a global `Symbol.for` brand, and `run-source`
 *    branches on it: an already-branded error skips the wrap that would attach
 *    this classification to the source row.
 * 3. The classifier is name-based by design (module identity is not trustworthy
 *    across HMR / worker threads), so a class hierarchy buys nothing it reads.
 *
 * The terminality is therefore declared once, in `classify-error.ts`, where the
 * reason for it can be written down next to every other terminal arm.
 */
export class BotChallengeError extends Error {
  /**
   * The literal evidence, so the message can quote what we saw rather than name
   * a vendor we inferred. `null` on the browser path when the refusal carried no
   * mitigation header at all — a bare 403/429 from a real browser is still a
   * refusal, it is just one we cannot attribute.
   */
  readonly mitigation: BotMitigation | null;
  /** The status of the response this was raised for. */
  readonly status: number;

  private constructor(
    message: string,
    status: number,
    mitigation: BotMitigation | null,
  ) {
    super(message);
    // Set here, not inherited: `classify-error.ts` matches `error.name`, and a
    // name check is what survives the module-identity differences that make
    // `instanceof` silently false — which here would downgrade a terminal
    // refusal to a transient retry-forever.
    this.name = "BotChallengeError";
    this.status = status;
    this.mitigation = mitigation;
  }

  /**
   * The user pinned this source to `plain`, and the site answered with a
   * challenge. We are not going to start a browser behind their back, so the
   * message is the remedy: the field, and the value to put in it.
   */
  static inPlainMode(
    status: number,
    mitigation: BotMitigation,
  ): BotChallengeError {
    return new BotChallengeError(
      `This page answers automated requests with a bot challenge (HTTP ${status}, ${mitigation.signal}). ` +
        `Set this source's Fetch mode to "Browser render" to load it in a real browser.`,
      status,
      mitigation,
    );
  }

  /**
   * A real browser, running the page's real JavaScript, was refused too. This is
   * where the retry loop has to stop: there is no further client to escalate to,
   * so every future attempt is the same request getting the same answer.
   */
  static afterRender(
    status: number,
    mitigation: BotMitigation | null,
  ): BotChallengeError {
    const evidence = mitigation
      ? `in a browser: HTTP ${status}, ${mitigation.signal}`
      : `in a browser: HTTP ${status}`;
    return new BotChallengeError(
      `A bot challenge blocks this page and a real browser did not get past it either (${evidence}). ` +
        `This page cannot be read automatically — remove the source, or point it at a URL that is not behind the challenge.`,
      status,
      mitigation,
    );
  }
}
