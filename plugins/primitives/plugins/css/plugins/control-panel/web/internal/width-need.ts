/**
 * The width a panel's CONTENT needs — the vocabulary's only width dial, and it
 * is turned by the content, never by the code that opens the panel:
 *
 * - `described` — choices that each carry a visible description line (its
 *   width decides how many lines each description wraps to);
 * - `picker` — a body that is a grid (swatches, icons, covers, a calendar);
 * - `builder` — a six-track rule row (filter, sort).
 *
 * `menu` — a list of short choices — is the baseline and is never declared.
 *
 * An element states its need as `data-cp-needs` ({@link CP_NEEDS_ATTR}):
 * `RuleRow` and a `Row` with a `description` stamp theirs themselves, and
 * content the vocabulary cannot see into (a foreign grid) declares it on the
 * `Section` / `Block` that holds it (`needs`). The popover surface collects
 * the showing page's needs in CSS (`cp-surface` in `app.css`) and takes
 * the highest-ranked one — menu < described < picker < builder — sized by the
 * matching `popoverWidth*` density token, so a theme sizes each bucket.
 *
 * It used to be declared by the OPENER (`ControlPanelPopover size`,
 * `PanelStackEntry.size`), which only knows what it opens by convention: the
 * view-settings menu's Fold rows page opened the filter builder at menu width
 * and its rule rows overflowed.
 */
export type ControlPanelWidthNeed = "described" | "picker" | "builder";

/** The attribute an element states its width need with. */
export const CP_NEEDS_ATTR = "data-cp-needs";
