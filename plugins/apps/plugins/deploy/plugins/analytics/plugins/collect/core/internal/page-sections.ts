import { z } from "zod";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/**
 * A page's full section list: every section the page registered for section
 * reach (`useSectionReach` / `observeSectionReach`), in page (document) order,
 * each named as its `section_reach` hit names it (`landing/hero`). The box
 * otherwise learns only the sections a visitor REACHED, so it is what a
 * page's "read %" is measured against.
 *
 * Sections register as they mount, so the list is complete only once the page
 * has rendered. The tracker therefore sends it with the pageview's engagement
 * beacons (its first is at the first hide or leave, long after the page
 * rendered), never with the pageview itself, and re-sends it whenever it grew;
 * the server keeps the longest list it got (it only grows).
 */

/** A page with more sections than this is a programming error: refused at registration. */
export const MAX_PAGE_SECTIONS = 32;
/** A section name (`<page>/<key>`) longer than this is refused at registration. */
export const MAX_SECTION_NAME_LENGTH = 64;

export const SectionNameSchema = z.string().min(1).max(MAX_SECTION_NAME_LENGTH);

/** A page's sections: distinct names, page order, at most {@link MAX_PAGE_SECTIONS}. */
export const PageSectionsSchema = cappedList(SectionNameSchema, {
  max: MAX_PAGE_SECTIONS,
}).refine((names) => new Set(names).size === names.length, {
  message: "section names must be distinct",
});
export type PageSections = z.infer<typeof PageSectionsSchema>;
