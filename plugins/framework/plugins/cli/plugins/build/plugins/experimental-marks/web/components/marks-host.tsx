import { useEffect } from "react";
import { useConfig } from "@plugins/config_v2/web";
import { MARKS_OFF_CLASS } from "../../core";
import { experimentalMarksConfig } from "../../core";

/** Keeps <html>'s marks-off class in step with the setting after load. */
export function ExperimentalMarksHost() {
  const { showExperimentalMarks } = useConfig(experimentalMarksConfig);
  useEffect(() => {
    document.documentElement.classList.toggle(
      MARKS_OFF_CLASS,
      !showExperimentalMarks,
    );
  }, [showExperimentalMarks]);
  return null;
}
