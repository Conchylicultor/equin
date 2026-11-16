/**
 * The global the request guard sets the moment it is installed — the app
 * entry's first statement. Its presence means page code now runs under the
 * guard, so the head's pre-entry window is closed (see
 * {@link headRequestScript}).
 */
export const REQUEST_GUARD_INSTALLED_GLOBAL = "__equinRequestGuardInstalled";

/**
 * A head script that starts requests to the app's own server before the app
 * entry runs (the boot snapshot, the icon sprites), parking them on a global
 * for the entry's boot task to take.
 *
 * It is an inline async module, so it does not wait for the render-blocking
 * stylesheet above it — but nothing orders it before the entry module either:
 * a browser may run it after the entry has installed the request guard, which
 * would refuse its raw `fetch` (a `RawApiRequestError`, and a rejected request
 * parked for the boot task to fail on). So the body runs only while the guard
 * is NOT installed: once it is, the head script does nothing, and the boot
 * task — finding no parked request — sends its own through the page
 * transport, exactly as on a shell served without the head fragment.
 *
 * `body` is plain JS (no imports), wrapped in a block so its declarations stay
 * its own.
 */
export function headRequestScript(body: string): string {
  return (
    `<script type="module" async>` +
    `if (globalThis[${JSON.stringify(REQUEST_GUARD_INSTALLED_GLOBAL)}] === undefined) {` +
    body +
    `}` +
    `</script>`
  );
}
