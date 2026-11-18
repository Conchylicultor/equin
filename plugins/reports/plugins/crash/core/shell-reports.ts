/**
 * The global the page shell's inline boot-failure reporter
 * (`framework/web-core`'s `index.html`) hands its report to once the app
 * entry has installed the page request guard — after which its own raw
 * `fetch("/api/reports")` would be refused.
 *
 * The protocol is a push-queue: the shell does
 * `(globalThis[name] = globalThis[name] || []).push(body)`. Until the crash
 * collector mounts, that is a plain array holding what was pushed; the
 * collector drains it into `report()` and puts an object in its place whose
 * `push` reports at once — so a report raised at any moment of the page's
 * life arrives, through the page's own report channel (the site's intake on
 * the website, the reports engine elsewhere).
 */
export const SHELL_REPORT_QUEUE_GLOBAL = "__equinShellReports";
