/**
 * A child's terminating signal as the spawn results report it: its name
 * (`"SIGTERM"`), or — for a signal with no name, such as a Linux real-time
 * signal, which Bun reports as its number — that number spelled as a string.
 */
export function signalName(
  signalCode: NodeJS.Signals | number | null,
): string | null {
  return signalCode === null ? null : String(signalCode);
}
