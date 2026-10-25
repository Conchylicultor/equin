import { createContext, useContext } from "react";
import type React from "react";

const LabelMarkContext = createContext<React.ReactNode>(null);

/**
 * A mark every row label inside `children` draws after its text — `Row`,
 * `Setting`, `Block` and `Group` alike, through their one label cell
 * (`HintedLabelCell`). For a HOST that renders rows it did not write (a slot's
 * contributions) and must say something about all of them — that a row is
 * developer-only — without each contributor remembering to.
 *
 * The provider renders no box: a panel's rows are its grid's direct subgrids,
 * so a wrapper element around a contributed row would break its rails.
 */
export function ControlPanelLabelMark({
  mark,
  children,
}: {
  mark: React.ReactNode;
  children: React.ReactNode;
}) {
  return <LabelMarkContext value={mark}>{children}</LabelMarkContext>;
}

/** The mark the nearest {@link ControlPanelLabelMark} asks labels to draw. */
export function useLabelMark(): React.ReactNode {
  return useContext(LabelMarkContext);
}
