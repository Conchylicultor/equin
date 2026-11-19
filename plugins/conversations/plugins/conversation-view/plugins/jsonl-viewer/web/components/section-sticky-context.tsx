import { createContext, useContext } from "react";

/**
 * Single source of truth for whether a section's user-text turn is expanded.
 * Owned by `TurnSection` (which both drops its stickiness and feeds this
 * value down to the turn's controlled `Expandable`), so the same fact drives
 * the header chrome and the clamp without a mirrored copy that could desync.
 */
export interface SectionExpand {
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
}

const SectionExpandContext = createContext<SectionExpand>({
  expanded: false,
  setExpanded: () => {},
});

export const SectionExpandProvider = SectionExpandContext.Provider;
export const useSectionExpand = () => useContext(SectionExpandContext);

/**
 * Where the section's prompt STARTS, relative to the reader: `scrolledPast`
 * while its first line is above the top of the transcript's viewport — the
 * prompt pinned over the turn it opened, or an expanded prompt read past its
 * top — and `jump` to bring that first line back to the top. Null outside a
 * prompt's section (an event card, a sub-agent's prompt drawn inline).
 */
export interface SectionStart {
  scrolledPast: boolean;
  jump: () => void;
}

const SectionStartContext = createContext<SectionStart | null>(null);

export const SectionStartProvider = SectionStartContext.Provider;
export const useSectionStart = () => useContext(SectionStartContext);
