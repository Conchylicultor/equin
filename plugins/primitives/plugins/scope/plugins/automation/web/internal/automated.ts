/**
 * Is this page driven by automation — `navigator.webdriver`: Playwright, an e2e
 * run, the agent browser? Read once per document (it cannot change for a page).
 *
 * A MARK, never a filter: an automated browser runs the code a visitor does, so
 * what it sees is recorded and reported like any other page's — stamped, so a
 * report says who saw it.
 */
export const AUTOMATED_BROWSER: boolean =
  typeof navigator !== "undefined" && navigator.webdriver === true;
