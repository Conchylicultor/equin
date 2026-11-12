import { useLayoutEffect, useRef } from "react";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { ANIMATION_HOST } from "@plugins/reports/plugins/render-loop/core";
import {
  mountSkillsGraph,
  type SkillsGraphHandle,
} from "../internal/skills-graph";

/**
 * The author's skills drawn as a program graph: AGENTS.md as main(), the
 * everyday skills funnelling into the meta skills (in the highlight colour),
 * one run of execution travelling down it while it is on screen, and each
 * skill's file and purpose on hover.
 *
 * React renders the host once; the drawing (`internal/skills-graph.ts`) owns
 * its shadow root from mount on, re-laid out when the host's width changes.
 */
export function SkillsGraph() {
  const hostRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<SkillsGraphHandle | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const graph = mountSkillsGraph(host);
    graphRef.current = graph;
    return () => {
      graphRef.current = null;
      graph.dispose();
    };
  }, []);

  useResizeObserver(hostRef, () => graphRef.current?.layout());

  // An animation host: the graph's run plays on its own rAF loop while on screen.
  return <div ref={hostRef} {...ANIMATION_HOST} />;
}
