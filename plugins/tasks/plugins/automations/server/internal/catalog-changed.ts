/**
 * "The catalog may have moved": the one signal every server-side change that
 * moves an `automations.catalog` entry raises (a filing, a launch, a release,
 * a config change, a decided launch), and the serve listens to.
 *
 * The signal is here and the serve is not, because the serve is the machine
 * half's (`automations.catalog` is `needsMachine` until the config split) and
 * `server/` never imports `machine/`. A listener that throws throws to the
 * raiser: nothing here swallows it.
 */
const listeners = new Set<() => void>();

/** Tell the catalog's subscribers to read it again. */
export function catalogChanged(): void {
  for (const listener of listeners) listener();
}

/** Listen for {@link catalogChanged}; returns the unsubscribe. */
export function onCatalogChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
