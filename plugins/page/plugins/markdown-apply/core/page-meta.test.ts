import { describe, expect, test } from "bun:test";
import { pageMetaHeader, splitPageMeta, type PageMeta } from "./page-meta";

const META: PageMeta = {
  kind: "agent-page",
  created: new Date("2026-07-14T09:12:34.567Z"),
  edited: new Date("2026-10-07T18:02:59Z"),
  breadcrumb: [
    { id: "block-root", title: "equin" },
    { id: "block-mid", title: 'Say "hi" \\ <now>' },
    { id: "block-self", title: "" },
  ],
  backlinks: [
    { id: "block-roadmap", title: "Roadmap" },
    { id: "block-log", title: "Log" },
  ],
  tags: [
    { name: "In progress", attrs: {} },
    { name: 'Say "hi"', attrs: {} },
  ],
};

const DOC =
  '# Hosted\n\nGoal: sync.\n<agent-inline id="block-1">\nnote\n</agent-inline>';

describe("pageMetaHeader", () => {
  test("states the breadcrumb root first and the times to the minute, UTC", () => {
    expect(pageMetaHeader(META)).toBe(
      [
        '<page-meta kind="agent-page" created="2026-07-14T09:12Z" edited="2026-10-07T18:02Z">',
        "  <tags>",
        '    <tag name="In progress"/>',
        '    <tag name="Say \\"hi\\""/>',
        "  </tags>",
        "  <breadcrumb>",
        '    <page id="block-root" title="equin"/>',
        '    <page id="block-mid" title="Say \\"hi\\" \\\\ <now>"/>',
        '    <page id="block-self" title=""/>',
        "  </breadcrumb>",
        "  <backlinks>",
        '    <page id="block-roadmap" title="Roadmap"/>',
        '    <page id="block-log" title="Log"/>',
        "  </backlinks>",
        "</page-meta>",
        "",
        "",
      ].join("\n"),
    );
  });
});

describe("splitPageMeta", () => {
  test("header + document splits back to exactly the document", () => {
    const split = splitPageMeta(pageMetaHeader(META) + DOC);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.rest).toBe(DOC);
    expect(split.meta?.attrs).toEqual({
      kind: "agent-page",
      created: "2026-07-14T09:12Z",
      edited: "2026-10-07T18:02Z",
    });
    // Titles come back unescaped: the header and the blocks share one attribute
    // quoting.
    expect(split.meta?.breadcrumb).toEqual(
      META.breadcrumb.map((c) => ({ ...c })),
    );
    expect(split.meta?.backlinks).toEqual(
      META.backlinks.map((c) => ({ ...c })),
    );
    expect(split.meta?.tags).toEqual(META.tags.map((t) => ({ ...t })));
  });

  test("no tags is stated as an empty <tags/>, first in the header", () => {
    const header = pageMetaHeader({ ...META, tags: [] });
    expect(header).toContain(
      'edited="2026-10-07T18:02Z">\n  <tags/>\n  <breadcrumb>',
    );
    const split = splitPageMeta(header + DOC);
    expect(split.ok && split.rest).toBe(DOC);
    expect(split.ok && split.meta?.tags).toEqual([]);
  });

  test("a header with no <tags> section reads tags as null, not []", () => {
    const old = pageMetaHeader(META).replace(/  <tags>\n[\s\S]*<\/tags>\n/, "");
    const split = splitPageMeta(old + DOC);
    expect(split.ok && split.rest).toBe(DOC);
    expect(split.ok && split.meta?.tags).toBeNull();
  });

  test("a tag line may carry new and color, read back unjudged", () => {
    const edited = pageMetaHeader(META).replace(
      "  </tags>",
      '    <tag name="Blocked" new="true" color="red"/>\n  </tags>',
    );
    const split = splitPageMeta(edited + DOC);
    expect(split.ok && split.rest).toBe(DOC);
    expect(split.ok && split.meta?.tags?.at(-1)).toEqual({
      name: "Blocked",
      attrs: { new: "true", color: "red" },
    });
  });

  test("a tags section emitted with attributes splits back to them", () => {
    const tags = [{ name: "Blocked", attrs: { new: "true" } }];
    const split = splitPageMeta(pageMetaHeader({ ...META, tags }) + DOC);
    expect(split.ok && split.meta?.tags).toEqual(tags);
  });

  test("a tag line with any other attribute is refused, naming it", () => {
    const edited = pageMetaHeader(META).replace(
      "  </tags>",
      '    <tag name="Blocked" colour="red"/>\n  </tags>',
    );
    const split = splitPageMeta(edited + DOC);
    expect(split.ok).toBe(false);
    if (split.ok) return;
    expect(split.reason).toContain('"colour"');
  });

  test("a tag line without a name is refused", () => {
    const edited = pageMetaHeader(META).replace(
      "  </tags>",
      '    <tag color="red"/>\n  </tags>',
    );
    expect(splitPageMeta(edited + DOC).ok).toBe(false);
  });

  test("a tag line outside <tags> is refused", () => {
    const edited = pageMetaHeader({ ...META, tags: [] }).replace(
      "</page-meta>",
      '<tag name="x"/>\n</page-meta>',
    );
    expect(splitPageMeta(edited + DOC).ok).toBe(false);
  });

  test("a crumb inside <tags> is refused", () => {
    const edited = pageMetaHeader(META).replace(
      "  </tags>",
      '    <page id="a" title="b"/>\n  </tags>',
    );
    expect(splitPageMeta(edited + DOC).ok).toBe(false);
  });

  test("no backlinks is stated as an empty <backlinks/>, and splits back", () => {
    const header = pageMetaHeader({ ...META, backlinks: [] });
    expect(header).toContain("\n  <backlinks/>\n</page-meta>");
    const split = splitPageMeta(header + DOC);
    expect(split.ok && split.rest).toBe(DOC);
    expect(split.ok && split.meta?.backlinks).toEqual([]);
  });

  test("a header from before backlinks (no section) still splits", () => {
    const old = pageMetaHeader(META).replace(
      /  <backlinks>\n[\s\S]*<\/backlinks>\n/,
      "",
    );
    const split = splitPageMeta(old + DOC);
    expect(split.ok && split.rest).toBe(DOC);
  });

  test("a section repeated is refused", () => {
    const doubled = pageMetaHeader(META).replace(
      "</page-meta>",
      "  <backlinks/>\n</page-meta>",
    );
    expect(splitPageMeta(doubled + DOC).ok).toBe(false);
  });

  test("a document with no header is returned whole", () => {
    expect(splitPageMeta(DOC)).toEqual({
      ok: true,
      meta: null,
      header: "",
      rest: DOC,
    });
  });

  test("changed values are still a header — they are read-only, not judged", () => {
    const edited = pageMetaHeader(META)
      .replace("2026-10-07T18:02Z", "1999-01-01T00:00Z")
      .replace('title="equin"', 'title="Renamed"');
    const split = splitPageMeta(edited + DOC);
    expect(split.ok && split.rest).toBe(DOC);
  });

  test("re-indented header lines are accepted", () => {
    const flat = pageMetaHeader(META)
      .split("\n")
      .map((l) => l.trim())
      .join("\n");
    const split = splitPageMeta(flat + DOC);
    expect(split.ok && split.rest).toBe(DOC);
  });

  test("a paragraph opening with an escaped < is not a header", () => {
    const doc = "\\<page-meta> is literal text";
    expect(splitPageMeta(doc)).toMatchObject({
      ok: true,
      meta: null,
      rest: doc,
    });
  });

  test("content written inside the header is refused, not dropped", () => {
    const header = pageMetaHeader(META).replace(
      "</page-meta>",
      "A new paragraph.\n</page-meta>",
    );
    const split = splitPageMeta(header + DOC);
    expect(split.ok).toBe(false);
    if (split.ok) return;
    expect(split.reason).toContain('"A new paragraph."');
  });

  test("a header with no closing tag is refused", () => {
    const header = pageMetaHeader(META).replace("</page-meta>\n", "");
    const split = splitPageMeta(header + DOC);
    expect(split.ok).toBe(false);
    if (split.ok) return;
    expect(split.reason).toContain("no closing </page-meta>");
  });

  test("a crumb outside the breadcrumb is refused", () => {
    const doc =
      '<page-meta created="x" edited="y">\n<page id="a" title="b"/>\n</page-meta>\n\n' +
      DOC;
    expect(splitPageMeta(doc).ok).toBe(false);
  });
});
