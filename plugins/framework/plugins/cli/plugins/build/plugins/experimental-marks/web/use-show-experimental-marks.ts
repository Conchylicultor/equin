import { useConfig } from "@plugins/config_v2/web";
import { EXPERIMENTAL_CLASS } from "../core";
import { experimentalMarksConfig } from "../core";

/** Whether this document is a build from worktree code (the build's stamp). */
export function isExperimentalBuild(): boolean {
  return document.documentElement.classList.contains(EXPERIMENTAL_CLASS);
}

/**
 * Whether the experimental marks (the frame, the Wish banner) show: the build
 * stamped this document experimental AND the user has not turned the marks
 * off. The one source every mark reads. Cosmetic, so the config's default
 * (on) while it loads is acceptable; the config is boot-preloaded anyway.
 */
export function useShowExperimentalMarks(): boolean {
  const { showExperimentalMarks } = useConfig(experimentalMarksConfig);
  return isExperimentalBuild() && showExperimentalMarks;
}
