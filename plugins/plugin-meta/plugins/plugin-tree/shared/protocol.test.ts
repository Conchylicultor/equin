import { describe, expect, test } from "bun:test";
import { readFromWorkerFrame, readToWorkerFrame } from "./protocol";

const node = {
  path: "fixture/a",
  name: "a",
  id: "a",
  descriptions: { web: "A" },
  loadBearing: false,
  collapsed: false,
  compositionRoot: false,
  runtimes: { web: true, server: false, machine: false, central: false },
  children: [],
  facets: "{}",
};
const ready = {
  type: "ready",
  facets: {
    kind: "built",
    delta: {
      roots: [
        {
          ...node,
          children: [{ ...node, path: "fixture/a/b", facets: null }],
        },
      ],
    },
  },
  ms: 12,
  steps: { snapshot: 3, related: 12 },
};

describe("worker frames are parsed at the boundary", () => {
  test("a frame of this code's protocol reads back as itself", () => {
    const read = readFromWorkerFrame(ready);
    expect(read).toEqual({ ok: true, frame: ready as never });
  });

  test("a field ADDED by the other side is stripped, not refused", () => {
    // An older worker's `ready` still carried `start`: a newer backend reads it.
    const read = readFromWorkerFrame({
      ...ready,
      start: { kind: "cold", reason: "x" },
    });
    expect(read.ok).toBe(true);
    if (read.ok) expect("start" in read.frame).toBe(false);
  });

  test("a frame that lost a field this code needs is refused, naming it", () => {
    const { steps: _, ...older } = ready;
    const read = readFromWorkerFrame(older);
    expect(read.ok).toBe(false);
    if (!read.ok)
      expect(read.issue).toContain(
        'a "ready" frame does not match this code\'s protocol at steps',
      );
  });

  test("a node deep in a delta is checked too", () => {
    const bad = structuredClone(ready);
    (
      bad.facets.delta.roots[0]!.children[0] as { loadBearing: unknown }
    ).loadBearing = "no";
    const read = readFromWorkerFrame(bad);
    expect(read.ok).toBe(false);
    if (!read.ok)
      expect(read.issue).toContain(
        "facets.delta.roots.0.children.0.loadBearing",
      );
  });

  test("an unknown frame type is refused", () => {
    const read = readFromWorkerFrame({
      type: "checkpoint-failed",
      message: "x",
    });
    expect(read.ok).toBe(false);
  });

  test("the backend's frames are read by the worker the same way", () => {
    // An older backend's init still named a checkpoint file.
    expect(
      readToWorkerFrame({ type: "init", root: "/r", checkpointFile: "/c" }),
    ).toEqual({
      ok: true,
      frame: { type: "init", root: "/r" },
    });
    expect(readToWorkerFrame({ type: "refresh", id: 1, paths: [] }).ok).toBe(
      false,
    );
  });
});
