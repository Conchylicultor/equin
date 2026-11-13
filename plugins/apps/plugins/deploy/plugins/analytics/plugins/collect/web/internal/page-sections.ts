import { MAX_PAGE_SECTIONS, MAX_SECTION_NAME_LENGTH } from "../../core";

/**
 * Every section registered for section reach, per page path, in page order —
 * what an engagement beacon sends as the page's `sections`
 * (`core/internal/page-sections.ts`).
 *
 * A section belongs to the path the address showed when it mounted: by then
 * the route has changed, while the tracker hears of the change only in an
 * effect that may run after the new page's sections registered — so asking
 * "what is mounted now" when the tracker sends the old page's last beacon
 * would answer with the new page's sections.
 *
 * A section that unmounts stays listed (it is still part of the page; a
 * revisit of the path mounts it again), so a path's list only grows during
 * the page load. Page order is the document order of the elements: a new
 * section goes before the first still-mounted one that follows it.
 */
export interface PageSectionRegistry {
  /** Registers `el` as section `name` of `path`; the returned function marks it unmounted. */
  register: (path: string, el: Element, name: string) => () => void;
  /** `path`'s sections so far, in page order. */
  sectionsOf: (path: string) => readonly string[];
  /** The element mounted as section `name` of `path` now, or null (not mounted, never registered). */
  elementOf: (path: string, name: string) => Element | null;
}

interface Entry {
  name: string;
  /** The mounted element, or null once it unmounted. */
  el: Element | null;
}

export function createPageSectionRegistry(): PageSectionRegistry {
  const byPath = new Map<string, Entry[]>();
  return {
    register(path, el, name) {
      if (name.length > MAX_SECTION_NAME_LENGTH)
        throw new Error(
          `[analytics] section ${JSON.stringify(name)} is longer than ${MAX_SECTION_NAME_LENGTH} characters`,
        );
      let entries = byPath.get(path);
      if (!entries) byPath.set(path, (entries = []));
      let entry = entries.find((e) => e.name === name);
      if (entry) {
        entry.el = el;
      } else {
        if (entries.length >= MAX_PAGE_SECTIONS)
          throw new Error(
            `[analytics] page ${path} registers more than ${MAX_PAGE_SECTIONS} sections (${JSON.stringify(name)})`,
          );
        entry = { name, el };
        const next = entries.findIndex(
          (e) =>
            e.el !== null &&
            e.el.isConnected &&
            (el.compareDocumentPosition(e.el) &
              Node.DOCUMENT_POSITION_FOLLOWING) !==
              0,
        );
        if (next === -1) entries.push(entry);
        else entries.splice(next, 0, entry);
      }
      const mine = entry;
      return () => {
        if (mine.el === el) mine.el = null;
      };
    },
    sectionsOf: (path) => byPath.get(path)?.map((e) => e.name) ?? [],
    elementOf: (path, name) => {
      const el = byPath.get(path)?.find((e) => e.name === name)?.el ?? null;
      return el !== null && el.isConnected ? el : null;
    },
  };
}
