/**
 * CSS custom property published by `<DataView>` on its root element, holding the
 * measured pixel height of its sticky toolbar (e.g. `"44px"`).
 *
 * Grouped view children (list, …) read it to stack their own sticky group
 * headers directly BELOW the toolbar — `top: var(--dv-header-offset, 0px)` — so
 * the two stacked sticky bands never overlap regardless of the toolbar's dynamic
 * height (compact/wide fold, control size, density). A documented cross-plugin
 * CSS-var contract, mirroring the `--chrome-mask` convention: the host publishes,
 * consumers read the same name. `0px` fallback keeps a header flush-top if the
 * var is ever absent (e.g. rendered outside a `<DataView>`).
 */
export const DATA_VIEW_HEADER_OFFSET_VAR = "--dv-header-offset";

/**
 * CSS custom property a grouped section's body publishes (`GroupedSections`):
 * where something pinned just below the section's own sticky header pins —
 * the header's `top` plus its measured height. A list row whose detail is
 * open pins there (`top: var(--dv-section-offset, var(--dv-header-offset,
 * 0px))`), so it stays under its section's header while its detail scrolls;
 * ungrouped, the var is absent and it pins under the toolbar.
 */
export const DATA_VIEW_SECTION_OFFSET_VAR = "--dv-section-offset";
