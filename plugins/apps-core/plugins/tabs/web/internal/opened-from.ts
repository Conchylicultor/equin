/**
 * The way back a tab carries (`Tab.openedFrom`): the launcher apps
 * (`defineApp({ launcher: true })` — Isle) it was opened from, oldest first,
 * the top the one the app launcher offers ("Back to <app>").
 *
 * After a swap from `prevAppId` to `appId`:
 * - leaving a launcher app pushes it;
 * - landing on an app already in the stack pops back to below it (the user
 *   went back there, by the launcher's line or any other way);
 * - every other swap keeps the stack as it is.
 */
export function openedFromAfterSwap(
  prev: { appId: string; openedFrom: readonly string[] },
  appId: string,
  isLauncher: (appId: string) => boolean,
): readonly string[] {
  const stack = isLauncher(prev.appId)
    ? [...prev.openedFrom.filter((id) => id !== prev.appId), prev.appId]
    : prev.openedFrom;
  const at = stack.indexOf(appId);
  return at < 0 ? stack : stack.slice(0, at);
}
