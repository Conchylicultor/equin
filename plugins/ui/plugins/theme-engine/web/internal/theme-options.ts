import { useThemes } from "../slots";

// Options-shaped read for the theme selection's DynamicEnum picker. The pending
// state (a resident source still loading) renders as an empty option list and
// self-fills on resolve; resident sources are boot-snapshot-hydrated live
// values (`preload: "boot-and-keep"`), settled on the first render, so in
// practice it is never observed.
export function useThemeOptions(): { value: string; label: string }[] {
  const state = useThemes();
  if (state.pending) return [];
  return [...state.themesById.values()].map((t) => ({
    value: t.id,
    label: t.label,
  }));
}
