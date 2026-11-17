import { describe, expect, test } from "bun:test";
import {
  applyLine,
  currentStep,
  emptyView,
  progress,
  type InstallView,
} from "./model";

const T = "2026-11-17T15:00:00Z";
const plan = JSON.stringify({
  v: 1,
  t: T,
  type: "plan",
  release: null,
  platform: "darwin-arm64",
  mode: "window",
  steps: [
    { id: "tools", label: "Prepare your Mac", est_s: null },
    { id: "clone", label: "Download equin", est_s: null },
  ],
});
const step = (id: string, state: string): string =>
  JSON.stringify({ v: 1, t: T, type: "step", id, state });
const log = (line: string): string =>
  JSON.stringify({
    v: 1,
    t: T,
    type: "log",
    step: "clone",
    stream: "out",
    line,
  });

function fold(lines: string[]): InstallView {
  const view = emptyView();
  for (const line of lines) applyLine(view, line);
  return view;
}

describe("installer page model", () => {
  test("running: the current step, progress by steps finished, a log section per step", () => {
    const view = fold([
      plan,
      step("tools", "skipped"),
      step("clone", "start"),
      log("\u001b[32mok\u001b[0m"),
    ]);
    expect(view.phase).toBe("running");
    expect(currentStep(view)?.step.label).toBe("Download equin");
    expect(currentStep(view)?.index).toBe(1);
    expect(progress(view)).toBe(0.5);
    expect(view.log).toEqual([
      { kind: "section", text: "Download equin" },
      { kind: "line", text: "ok" },
    ]);
  });

  test("a failed step pauses; a new start resumes", () => {
    const failed = fold([
      plan,
      step("clone", "start"),
      step("clone", "failed"),
    ]);
    expect(failed.phase).toBe("failed");
    const resumed = fold([
      plan,
      step("clone", "start"),
      step("clone", "failed"),
      step("clone", "start"),
    ]);
    expect(resumed.phase).toBe("running");
  });

  test("done, then exit 0, stays done", () => {
    const view = fold([
      plan,
      step("clone", "done"),
      JSON.stringify({
        v: 1,
        t: T,
        type: "done",
        url: "http://equin.localhost:9000",
        ms: 1000,
      }),
      JSON.stringify({ v: 1, t: T, type: "exit", code: 0 }),
    ]);
    expect(view.phase).toBe("done");
    expect(view.doneUrl).toBe("http://equin.localhost:9000");
    expect(progress(view)).toBe(1);
  });

  test("exit without done is stopped", () => {
    const view = fold([
      plan,
      step("clone", "failed"),
      JSON.stringify({ v: 1, t: T, type: "exit", code: 1 }),
    ]);
    expect(view.phase).toBe("stopped");
    expect(view.exitCode).toBe(1);
  });

  test("a line outside the protocol is a loud error, and nothing after it is folded", () => {
    const view = fold([plan, '{"v":2,"type":"plan"}', step("clone", "start")]);
    expect(view.phase).toBe("protocol-error");
    expect(view.protocolError).toContain('{"v":2');
  });
});
