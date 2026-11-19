/**
 * The activation of a page-link chip that opens nothing — a still-resolving or
 * not-found chip, and a chip rendered where the host declared no navigation (a
 * version diff, the public site). Still an activation rather than none:
 * `LinkChip` isolates its click, so pressing the chip never also activates the
 * block or row around it, which is what the chip's `stopPropagation` used to do.
 */
export const INERT_ACTIVATION = (): void => undefined;
