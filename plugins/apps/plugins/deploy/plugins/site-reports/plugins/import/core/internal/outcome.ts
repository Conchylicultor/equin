/**
 * What one pull from a deployment's box came to. Every failure files nothing
 * (it learned nothing about the site's errors); it is logged and kept on the
 * deployment's import row.
 */
export const IMPORT_OUTCOMES = [
  // The list answered; zero or more reports were recorded.
  "imported",
  // No SSH key / host key never pinned: the Deploy app's own setup says so.
  "not-connected",
  "ssh-failed",
  // curl failed on the box: the site is down, timed out, or answered an HTTP
  // error.
  "request-failed",
  // The site answered 404: its release does not serve the intake's list
  // (deployed before it, or its composition does not ship it).
  "route-missing",
  // The box answered something that is not the list, or over the byte cap.
  "unreadable-answer",
] as const;
export type ImportOutcome = (typeof IMPORT_OUTCOMES)[number];
