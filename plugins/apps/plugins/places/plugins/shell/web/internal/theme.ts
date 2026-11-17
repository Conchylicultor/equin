import { defineTheme } from "@plugins/ui/plugins/theme-engine/core";

/**
 * The Places app's own theme: the schema defaults, so Places never wears the
 * desktop's runtime theme choice. Selected for the app in
 * `config/ui/theme-engine/@app/places/theme.jsonc`. Light only — but that is
 * the app's declared `colorMode` (`core/app.ts`), which stamps the light scheme
 * on its scope for every token group, not something a theme spells group by
 * group.
 */
export const placesTheme = defineTheme({
  id: "places",
  label: "Places",
  fragments: [],
});
