import {
  Badge,
  type BadgeVariant,
} from "@plugins/primitives/plugins/css/plugins/badge/web";
import type { AlignmentCandidate } from "../../core";
import { percent } from "../internal/recording-state";

/** A match chip: what a video's alignment came to, in a word or a score. */
export interface Chip {
  variant: BadgeVariant;
  label: string;
  title?: string;
}

/** What came of trying one candidate. */
export function outcomeChip(candidate: AlignmentCandidate): Chip {
  switch (candidate.outcome) {
    case "aligned":
      return {
        variant: "success",
        label: candidate.score === null ? "Aligned" : percent(candidate.score),
      };
    case "weak":
      return {
        variant: "warning",
        label:
          candidate.score === null
            ? "Weak"
            : `Weak ${percent(candidate.score)}`,
      };
    case "failed":
      return {
        variant: "destructive",
        label: "Failed",
        title: candidate.error ?? undefined,
      };
    case "not-embeddable":
      return {
        variant: "destructive",
        label: "Can't embed",
        title: "YouTube does not let this video play inside the app",
      };
    case "untried":
      return { variant: "muted", label: "Not tried" };
    case "trying":
      return { variant: "primary", label: "Trying" };
  }
}

export function ChipBadge({ chip }: { chip: Chip }) {
  return (
    <Badge variant={chip.variant} shape="pill" tooltip={chip.title}>
      {chip.label}
    </Badge>
  );
}
