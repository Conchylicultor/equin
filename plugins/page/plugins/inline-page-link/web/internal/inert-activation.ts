/**
 * The activation of a page-link chip that opens nothing — the static render
 * (which declares no navigation by design), the not-found chip, and an editor
 * mounted where the host declared none. Still an activation rather than none:
 * `LinkChip` isolates its click, so pressing the chip never also activates the
 * block or row around it, which is what the chip's `stopPropagation` used to do.
 */
export const INERT_ACTIVATION = (): void => undefined;
