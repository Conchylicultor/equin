import type { Score } from "@plugins/apps/plugins/sonata/plugins/score/core";
import type {
  BeatSpan,
  ProgressLabel,
} from "@plugins/apps/plugins/sonata/plugins/progress/plugins/scrubber/web";
import type { ReactNode } from "react";
import {
  SectionDescription,
  SectionLabel,
  SectionLoopButton,
} from "./components/section-label";
import { sectionAt, sectionsOf } from "./section-model";

/** Chapters: one rail segment per section, by start. */
export function sectionsChapters(score: Score): readonly BeatSpan[] {
  return sectionsOf(score).map((s) => ({ start: s.start, end: s.end }));
}

/**
 * Label lane: per section, its label at the start and a loop button pinned to
 * the group's right edge (revealed while the group — the whole section's width
 * in the lane — is hovered).
 */
export function sectionsLabels(score: Score): readonly ProgressLabel[] {
  return sectionsOf(score).flatMap((s, idx): ProgressLabel[] => [
    {
      beat: s.start,
      key: `${s.start}-${idx}`,
      node: <SectionLabel name={s.data.name} start={s.start} end={s.end} />,
    },
    {
      beat: s.start,
      key: `${s.start}-${idx}-loop`,
      node: <SectionLoopButton start={s.start} end={s.end} />,
      align: "end",
    },
  ]);
}

/** Hover preview body: the section under the pointer, `● name`. */
export function sectionsDescribe(score: Score, beat: number): ReactNode {
  const section = sectionAt(sectionsOf(score), beat);
  return section ? <SectionDescription name={section.data.name} /> : null;
}
