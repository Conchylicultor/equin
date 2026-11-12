import { useLayoutEffect, useRef } from "react";
import { ANIMATION_HOST } from "@plugins/reports/plugins/render-loop/core";
import { App, type FigureMode } from "../internal/app";

/**
 * The host one data-view figure draws into: React renders it once and the
 * figure (`internal/app.ts`) owns its shadow root from mount on — its lists,
 * menus and the feature lines' highlight boxes.
 */
function DataViewFigure({ mode }: { mode: FigureMode }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const app = new App(host, mode);
    return () => app.dispose();
  }, [mode]);

  // An animation host: a hovered feature line keeps its highlight box on its
  // target frame by frame (a search field growing, a list scrolling under it).
  return <div ref={hostRef} {...ANIMATION_HOST} />;
}

/**
 * A Notion-like database page — a reading list — drawn straight on the page
 * by the same data view as the equin Artifacts page: views as tabs, search,
 * filter, sort, view settings (layout, group by) and New, in list, gallery or
 * table, loading more as it scrolls. Invented books; a picture of a data view,
 * not a live one.
 */
export function NotionDataView() {
  return <DataViewFigure mode="notion" />;
}

/**
 * The Claude app today: its sidebar (chats) and its Artifacts page, each its
 * own partial reimplementation of a data view, with one feature line per
 * capability under them (present / partial / missing); hovering a line shows
 * that capability in both surfaces at once.
 */
export function ClaudeBefore() {
  return <DataViewFigure mode="before" />;
}

/**
 * The same two Claude surfaces rebuilt on ONE data view: the sidebar folds its
 * controls into a view button and a settings button, the page draws the full
 * bar; every feature line now reads the same on both sides, and hovering one
 * shows it in both surfaces at once.
 */
export function ClaudeAfter() {
  return <DataViewFigure mode="after" />;
}
