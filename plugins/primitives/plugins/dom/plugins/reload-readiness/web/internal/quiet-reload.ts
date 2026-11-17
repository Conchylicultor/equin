import { flushKept } from "@plugins/primitives/plugins/kept-state/web";
import { holdsCleared, readReloadReadiness } from "./readiness-store";

/**
 * Reload without losing anything: write every pending kept-state write, wait
 * until no process holds the page, write again (the wait may have let more
 * typing in), then reload. Never resolves — the page goes away.
 *
 * It does not wait for the user to look away or stop typing: picking the
 * moment (hidden, idle, not engaged) is the reload policy's call, read from
 * `useReloadReadiness()`. This only guarantees that the reload itself loses
 * nothing a kept-state or a hold covers.
 */
export function quietReload(): Promise<never> {
  return reloadWhenReleased(() => window.location.reload());
}

/** `quietReload` over its last step, so a test can watch it instead of reloading. */
export async function reloadWhenReleased(reload: () => void): Promise<never> {
  flushKept();
  // A hold may be taken again between the last release and this continuation.
  while (readReloadReadiness().holds.length > 0) await holdsCleared();
  flushKept();
  reload();
  return new Promise<never>(() => {});
}
