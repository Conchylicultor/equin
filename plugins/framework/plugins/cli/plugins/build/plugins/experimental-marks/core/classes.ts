/**
 * The class the build stamps on <html> of a dist built from worktree code
 * (`cli/build`'s experimental-marker). The browser cannot infer this fact.
 */
export const EXPERIMENTAL_CLASS = "experimental";

/**
 * The class the Show experimental marks setting puts on <html> when it is off
 * (a head script before first paint, then the web effect). ui-kit's
 * `theme/app.css` frame rule is `.experimental:not(.experimental-marks-off)`.
 */
export const MARKS_OFF_CLASS = "experimental-marks-off";
