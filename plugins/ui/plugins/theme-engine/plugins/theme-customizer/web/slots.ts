import { defineDetailSections } from "@plugins/primitives/plugins/detail-sections/web";

export const ThemeCustomizer = defineDetailSections<{ search: string }>({
  // Each section lives in a small `customizer` child of the plugin it edits
  // (a token group, the theme gallery…), split off so painting never depends
  // on this editor loading. Nothing imports those children, so they ship as
  // companions: wherever the customizer does.
  companions: true,
});
