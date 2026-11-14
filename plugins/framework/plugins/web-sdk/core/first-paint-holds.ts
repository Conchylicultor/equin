// First-paint holds: work a module evaluated during the boot asks the first
// paint to wait for.
//
// The boot commits the active app whole with its first frame (web-core's
// App.tsx: the app's code loads as the "App code" boot task). Some of what that
// frame draws is not in the app's code itself but behind a dynamic import the
// code starts while it evaluates — a code-split page body the URL being opened
// shows (`lazyComponent`'s `preload: "first-paint"`). Without a hold the frame
// is drawn without it and the content pops in a beat later; with one, the "App
// code" task settles only once the work has.
//
// Holds are taken once, by that boot task. Anything registered after (a module
// evaluated after the first paint) has no frame left to hold and is dropped.

const holds = new Set<Promise<unknown>>();
let open = true;

/**
 * Ask the first paint to wait for `work`. A rejection fails the boot's "App
 * code" task (the boot screen says so, with Retry and Continue anyway) — the
 * frame it was needed for could not be drawn. After the first paint's holds
 * have been taken this does nothing: there is no first frame left to hold.
 */
export function holdFirstPaint(work: Promise<unknown>): void {
  if (open) holds.add(work);
}

/** Whether any work holds the first paint right now. Read by the boot. */
export function hasFirstPaintHolds(): boolean {
  return holds.size > 0;
}

/**
 * Every hold registered so far, settled: resolves once all have, rejects with
 * the first failure. Closes the registry — read once, by the boot's "App code"
 * task, after the app's code has evaluated (which is when holds register).
 */
export async function takeFirstPaintHolds(): Promise<void> {
  open = false;
  const taken = [...holds];
  holds.clear();
  await Promise.all(taken);
}
