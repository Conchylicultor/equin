import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { SubjectError } from "@plugins/packages/plugins/error-subject/core";
import {
  STAGE_DEADLINE_MS,
  useStageDeadline,
} from "../internal/stage-deadline";

/** A loading stage that outlasts its deadline on screen becomes a failure naming it. */

let seen: Error | null = null;

function Probe({
  stage,
  onScreen,
}: {
  stage: string | null;
  onScreen: boolean;
}) {
  const stuck = useStageDeadline(stage, onScreen);
  useEffect(() => {
    seen = stuck;
  }, [stuck]);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  seen = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useStageDeadline", () => {
  it("fails a stage left on screen past the deadline, naming it", () => {
    render(<Probe stage="Painting the signs" onScreen />);
    act(() => {
      vi.advanceTimersByTime(STAGE_DEADLINE_MS - 1);
    });
    expect(seen).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(seen?.message).toContain("Painting the signs");
    expect(seen).toBeInstanceOf(SubjectError);
    expect((seen as SubjectError).subject).toBe(
      "isle loading stage: Painting the signs",
    );
  });

  it("restarts the deadline when the stage moves on, and never fires once loaded", () => {
    const { rerender } = render(<Probe stage="Reading the map" onScreen />);
    act(() => {
      vi.advanceTimersByTime(STAGE_DEADLINE_MS - 1000);
    });
    rerender(<Probe stage="Painting the signs" onScreen />);
    act(() => {
      vi.advanceTimersByTime(STAGE_DEADLINE_MS - 1000);
    });
    expect(seen).toBeNull();
    rerender(<Probe stage={null} onScreen />);
    act(() => {
      vi.advanceTimersByTime(STAGE_DEADLINE_MS * 2);
    });
    expect(seen).toBeNull();
  });

  it("does not count time off screen", () => {
    render(<Probe stage="Drawing the island" onScreen={false} />);
    act(() => {
      vi.advanceTimersByTime(STAGE_DEADLINE_MS * 2);
    });
    expect(seen).toBeNull();
  });
});
