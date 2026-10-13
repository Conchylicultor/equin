import type { LiveCollection } from "@plugins/network/plugins/live/core";
import { startPages } from "../../shared/page-plan";
import { pageSourceOf } from "../internal/page-source";

/**
 * The tuple a paged read of `collection` subscribes for its first page, asked
 * nothing (`{}`): the page plan's start page, encoded by the collection's page
 * source. It must equal the collection's plain default tuple
 * (`window.defaultParams`) — the one the boot snapshot hydrates — so a paged
 * reader and a plain one share it.
 */
export function pageZeroParams<Row, F, S extends string>(
  collection: LiveCollection<Row, F, S>,
): Record<string, string> {
  const source = pageSourceOf(collection);
  const [start] = startPages({ ...source.limits, staleRows: 0 }).pages;
  return source.params({}, start!.page);
}
