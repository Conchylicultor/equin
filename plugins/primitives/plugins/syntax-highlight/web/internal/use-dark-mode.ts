import { useColorScheme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";

/**
 * Whether the region this component renders in is dark — the nearest scheme
 * boundary's, not `<html>`'s: a light app inside a dark desktop highlights its
 * code light.
 */
export function useDarkMode(): boolean {
  return useColorScheme() === "dark";
}
