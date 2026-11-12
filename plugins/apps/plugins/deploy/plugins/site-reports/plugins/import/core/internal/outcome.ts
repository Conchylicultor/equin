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
  // error — a 404 when the deployed composition does not ship the intake.
  "request-failed",
  // The box answered something that is not the list, or over the byte cap.
  "unreadable-answer",
] as const;
export type ImportOutcome = (typeof IMPORT_OUTCOMES)[number];
