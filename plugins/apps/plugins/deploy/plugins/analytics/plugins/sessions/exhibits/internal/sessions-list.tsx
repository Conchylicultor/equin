import { useMemo, useState, type ReactNode } from "react";
import {
  SESSION_SHAPES,
  type SessionShape,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { SessionsList } from "../../web/components/sessions-section";
import { journeyOf } from "../../web/internal/journey";
import { fixtureSessions } from "./fixture";

const READY = { status: "ready" } as const;

/** The Sessions list on made-up visits: the shape switch filters them in memory, as the box would. */
export default function SessionsListExhibit(): ReactNode {
  // Made up once, relative to the moment the exhibit opens.
  const [all] = useState(() => fixtureSessions(Date.now()));
  const [shape, setShape] = useState<SessionShape>("all");
  const counts = useMemo(() => {
    const of = (s: SessionShape) =>
      all.filter((v) => {
        const j = journeyOf(v);
        return s === "all"
          ? true
          : s === "actions"
            ? j.actionCount > 0
            : s === "multi"
              ? v.pageviews > 1
              : v.pageviews <= 1;
      });
    return Object.fromEntries(SESSION_SHAPES.map((s) => [s, of(s)])) as Record<
      SessionShape,
      typeof all
    >;
  }, [all]);
  return (
    <SessionsList
      rows={counts[shape]}
      readiness={READY}
      paging={null}
      shape={shape}
      onShape={setShape}
      counts={
        Object.fromEntries(
          SESSION_SHAPES.map((s) => [s, counts[s].length]),
        ) as Record<SessionShape, number>
      }
    />
  );
}
