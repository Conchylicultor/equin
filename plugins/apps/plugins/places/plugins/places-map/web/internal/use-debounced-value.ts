import { useEffect, useState } from "react";

/**
 * Returns `value` only after it has stayed unchanged for `delayMs` — what keeps
 * the Add place search from asking Google per keystroke.
 *
 * The third private copy of this six-liner (`page/place`, `search/quick-find`):
 * by their own note, the point at which it earns a primitive.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
