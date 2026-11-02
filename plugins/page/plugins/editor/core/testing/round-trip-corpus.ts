import type { BlockHandle } from "../define-block";
import type { RichText } from "../rich-text";
import type { SerializedBlock } from "../serialized-block";

// The round-trip property's corpus: a fuzzed forest generator over the REAL
// block handles, shared by `core/markdown.test.ts` (which asserts
// `parse(serialize(forest)) ≡ forest` over it) and the
// `page.editor:markdown-round-trip-covers-every-block` check (which refuses a
// registered block type the generator never produces).
//
// The coverage half lives in a CHECK because `./equin build` and `push` run
// checks and nothing runs tests: the `prototype` block shipped with no
// generator, so its round trip went unchecked and the only signal was a test
// failure nobody saw. Reading the generated types off THIS table — not a copy
// of them — is what lets the check and the property never disagree.

/** One way to fuzz one block type's data; `children: false` for a self-closing tag. */
export interface BlockGenerator {
  type: string;
  data(r: () => number): unknown;
  children: boolean;
}

export interface RoundTripCorpus {
  /** Every line the registry says it takes away from plain prose. */
  claimLines: readonly string[];
  generators: readonly BlockGenerator[];
  /** One random block (and its random subtree) at `depth`. */
  build(r: () => number, depth: number): SerializedBlock;
}

/** Registered block types the corpus never generates — empty when it covers them all. */
export function ungeneratedBlockTypes(
  handles: readonly BlockHandle<unknown>[],
  corpus: RoundTripCorpus,
): string[] {
  const generated = new Set(corpus.generators.map((g) => g.type));
  return handles.map((h) => h.type).filter((t) => !generated.has(t));
}

function byType(
  handles: readonly BlockHandle<unknown>[],
  type: string,
): BlockHandle<unknown> {
  const found = handles.find((h) => h.type === type);
  if (!found) {
    throw new Error(
      `No block handle of type "${type}" is registered, so the round-trip ` +
        `corpus cannot read it. Registered types: ` +
        handles.map((h) => h.type).join(", "),
    );
  }
  return found;
}

/** Mulberry32 — deterministic, so a failure is reproducible from its seed. */
export const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export function roundTripCorpus(
  handles: readonly BlockHandle<unknown>[],
): RoundTripCorpus {
  // Every line the REAL registry says it takes away from plain prose: each
  // hand-written claimer's declared samples (`markdown.parseLine.claims`), plus
  // `prefix + "x"` for every `markdownPrefixes` entry — a prefix IS its own
  // declaration, so it needs no second one.
  //
  // This is where the generator's alphabet comes from now, and it is the whole
  // point of this pass. It used to come from a word list chosen so that no
  // generated paragraph COULD open with a block marker, under a comment calling
  // that "a genuine lossiness of markdown itself". That premise was the bug:
  // CommonMark spells a literal marker with one leading backslash, the
  // serializer writes that now, and the property could never see any of it
  // because the fuzzer was built never to emit a line anybody would claim.
  const CLAIM_LINES: readonly string[] = [
    ...new Set(
      handles.flatMap((h) => [
        ...(h.markdown?.parseLine?.claims ?? []),
        ...(h.markdown?.lineRun?.claims ?? []),
        ...(h.markdownPrefixes ?? []).map((prefix) => prefix + "x"),
      ]),
    ),
  ];

  // Ordinary prose, and it no longer has to dodge anything — `pick` opens
  // roughly one text in four with a `CLAIM_LINES` entry instead.
  //
  // What the list still avoids is a soft break at a word's START or END.
  // `hoistBoundaryWhitespace` trims with `trimStart`/`trimEnd`, which treat
  // `\n` as whitespace, so a MARKED run ending in a break canonicalizes to a
  // bold run plus a bare one — a legitimate canonical-form rewrite (pinned in
  // `inline-markdown.test.ts`), not a defect, and this property asserts the
  // EXACT round trip. Hence one word with an INTERIOR break and no bare `"\n"`
  // entry, and no word starting with a space.
  //
  // The old list also excluded `[ ] ` and `* `, under the same heading, and
  // that half was simply FALSE. `[`, `]` and `*` are inline escape spellings,
  // so by the time a line exists they read `\[`, `\]` and `\*` and no claimer
  // can reach the line's first character. They were never claimable and never
  // lossy.
  const words = [
    "alpha",
    "bravo",
    "charlie",
    "delta*star",
    "echo_under",
    "foxtrot<lt",
    "golf\nhotel",
  ];

  /**
   * The callout's real colour set, READ OFF its registered schema rather than
   * copied into this file. A colour is not a block TYPE, so the coverage
   * assertion below would never notice a sixth one — reading the enum is what
   * stops this generator drifting the way the hand-written copy did, which knew
   * two of the five.
   */
  const CALLOUT_COLORS: readonly string[] = (() => {
    const color = (
      byType(handles, "callout").schema as unknown as {
        shape: Record<
          string,
          { removeDefault?: () => { options?: readonly string[] } } | undefined
        >;
      }
    ).shape.color;
    const options = color?.removeDefault?.().options;
    if (!options?.length) {
      throw new Error(
        "page/callout no longer declares `color` as a defaulted enum, so the " +
          "round-trip generator cannot read its colour set off the schema.",
      );
    }
    return options;
  })();

  const gens: BlockGenerator[] = [
    { type: "text", data: (r) => ({ text: pick(r) }), children: true },
    // A paragraph that ALWAYS opens with a line another type would claim — the
    // shape the escape exists for, and precisely the one the old word list was
    // built to make impossible. `pick` reaches it about one text in four, which
    // over the whole corpus came out at thirteen lines; this entry makes it a
    // first-class member so the non-vacuity count below is a real sample rather
    // than a handful of accidents.
    { type: "text", data: (r) => ({ text: claimOpening(r) }), children: true },
    // An empty paragraph is a BLANK LINE where one can state its position, and
    // the handle's `<text/>` tag where one cannot (first, last, or carrying
    // children — see the pin in `describe("empty paragraphs")`). So it may own
    // children here, and the property below asserts the EXACT round trip over
    // every position the generator can produce, with no narrowing.
    { type: "text", data: () => ({ text: [] }), children: true },
    // Three soft-break shapes the word list cannot reach, each canonical and
    // each a real row on main. `pick` joins words with spaces and marks them
    // 40% of the time, so the interior break above already covers a break inside
    // a marked run, inside an unmarked one, in every text-bearing type and in
    // the `prompt` tag body — these are the ones it cannot produce.
    //
    // A run that is ONLY a break: the shape the empty-block pin used to claim
    // (`line.trim() === ""`) and delete outright.
    { type: "text", data: () => ({ text: [{ text: "\n" }] }), children: true },
    // A TRAILING break, unmarked so the hoist has nothing to rewrite — what a
    // `<p>a</p><p></p>` paste leaves behind.
    {
      type: "text",
      data: () => ({ text: [{ text: "india\n" }] }),
      children: true,
    },
    // The three-run `[bold "a"][break][bold "b"]` shape `walkNode` actually
    // produces for a marked line split by Shift+Enter: the break is its own
    // unmarked run, so `coalesce` cannot merge it into either neighbour.
    {
      type: "text",
      data: () => ({
        text: [
          { text: "juliett", marks: ["bold" as const] },
          { text: "\n" },
          { text: "kilo", marks: ["bold" as const] },
        ],
      }),
      children: true,
    },
    { type: "bulleted-list", data: (r) => ({ text: pick(r) }), children: true },
    { type: "heading-1", data: (r) => ({ text: pick(r) }), children: true },
    { type: "heading-2", data: (r) => ({ text: pick(r) }), children: true },
    { type: "heading-3", data: (r) => ({ text: pick(r) }), children: true },
    { type: "numbered-list", data: (r) => ({ text: pick(r) }), children: true },
    { type: "toggle", data: (r) => ({ text: pick(r) }), children: true },
    { type: "quote", data: () => ({}), children: true },
    { type: "prompt", data: (r) => ({ text: pick(r) }), children: true },
    {
      type: "to-do",
      data: (r) => ({ text: pick(r), checked: r() < 0.5 }),
      children: true,
    },
    { type: "divider", data: () => ({}), children: true },
    {
      type: "code-block",
      data: (r) => ({
        code: `const x = ${Math.floor(r() * 100)};\nreturn x;`,
        ...(r() < 0.5 ? { language: "ts" } : {}),
      }),
      children: true,
    },
    {
      type: "equation",
      data: (r) => ({ expression: `x^${Math.floor(r() * 9)}` }),
      children: true,
    },
    {
      type: "callout",
      data: (r) => ({
        icon: r() < 0.5 ? null : "info",
        color: CALLOUT_COLORS[Math.floor(r() * CALLOUT_COLORS.length)]!,
      }),
      children: true,
    },
    // The annotation family, under the names and tags the app really ships:
    // `<human>`, `<private-note>`, `<todo>`, `<instructions>` and the agent's
    // own `<agent-inline>`. The old copy of this suite had four of them under
    // invented types and tags, so what round-tripped here was a document
    // nothing ever writes.
    { type: "context", data: () => ({}), children: true },
    { type: "private-note", data: () => ({}), children: true },
    { type: "todo", data: () => ({}), children: true },
    // `global` is emitted ONLY when true, so `{global: false}` comes back `{}`
    // — a real, narrow round-trip loss in the instructions card, named here
    // rather than hidden by a generator that avoids the value by accident.
    {
      type: "instructions",
      data: (r) => (r() < 0.5 ? {} : { global: true }),
      children: true,
    },
    // Id-less here, which is the point: the fuzz forest exercises the OMIT
    // branch of the identified tag — a card with no row id still serializes,
    // and comes back with no `ref` key at all.
    { type: "agent-note", data: () => ({}), children: true },
    {
      type: "image",
      data: (r) => ({
        attachmentId: `att_${Math.floor(r() * 1000)}`,
        ...(r() < 0.5 ? { width: 320 + Math.floor(r() * 640) } : {}),
        ...(r() < 0.5 ? { alt: "a cat" } : {}),
      }),
      children: true,
    },
    {
      type: "video",
      data: (r) => ({ attachmentId: `v_${Math.floor(r() * 99)}` }),
      children: true,
    },
    {
      type: "audio",
      data: (r) => ({ attachmentId: `s_${Math.floor(r() * 99)}` }),
      children: true,
    },
    {
      type: "file",
      data: (r) => ({ filename: "notes.pdf", size: Math.floor(r() * 5000) }),
      children: true,
    },
    {
      type: "embed",
      data: () => ({ url: "https://example.com/e" }),
      children: true,
    },
    // `place` is the one type whose tag declares NON-STRING attributes of its
    // own: `lat`/`lng` as numbers, and the resolve stamp as an ISO 8601 date
    // rather than the epoch milliseconds the row stores. Both directions are
    // hand-written, so both are exercised — a fractional coordinate, a negative
    // one, and a timestamp with milliseconds on it.
    //
    // `children: false` for `page-link`'s reason: `body: "none"` self-closes,
    // so a child would be CONSUMED rather than emitted. A place is one object,
    // with no content of its own to nest under.
    {
      type: "place",
      data: (r) => ({
        providerId: "google",
        placeId: `pid_${Math.floor(r() * 999)}`,
        name: 'Caf\u00e9 "du coin"',
        address: "1 rue de la Paix",
        ...(r() < 0.5 ? { category: "Coffee shop" } : {}),
        ...(r() < 0.5 ? { mapsUrl: "https://maps.example/x" } : {}),
        ...(r() < 0.5
          ? { lat: 48.8566, lng: -2.3522 }
          : { lat: -33.8688, lng: 151.2093 }),
        ...(r() < 0.5 ? { fetchedAt: 1755518400123 } : {}),
      }),
      children: false,
    },
    // A GFM table: a LINE RUN, the one claim kind with no closing line. Cells
    // come from the same alphabet as every paragraph (so a cell can open with a
    // claimed line, hold a soft break or a mark), plus the three shapes only a
    // table cares about: a literal `|`, a cell reading as a delimiter cell, and
    // an empty one. Children allowed — a table's children nest below it by
    // indent, which is exactly the boundary the run collector must respect.
    {
      type: "table",
      data: (r) => {
        const width = 1 + Math.floor(r() * 3);
        const aligns = ["left", "center", "right", null] as const;
        const row = (): RichText[] =>
          Array.from({ length: width }, () => tableCell(r));
        return {
          align: Array.from(
            { length: width },
            () => aligns[Math.floor(r() * aligns.length)]!,
          ),
          header: row(),
          rows: Array.from({ length: Math.floor(r() * 3) }, row),
        };
      },
      children: true,
    },
    {
      type: "bookmark",
      data: (r) => ({
        url: "https://example.com",
        ...(r() < 0.5 ? { title: 'a "quoted" title' } : {}),
        ...(r() < 0.5 ? { fetched: true } : {}),
        ...(r() < 0.5 ? { attachmentIds: ["i1", "f1"] } : {}),
      }),
      children: true,
    },
    // `page-link` is a POINTER: its body is `"none"`, so it never carries
    // children (they belong to the page it points at, not to this document).
    {
      type: "page-link",
      data: (r) => ({ pageId: `p${Math.floor(r() * 99)}` }),
      children: false,
    },
    // `<prototype id="proto-…"/>`: `body: "none"`, so no children. The size
    // attributes are numbers on the row and strings in the tag, each optional
    // on its own; the annotated `title` is never on the row, so never here.
    {
      type: "prototype",
      data: (r) => ({
        prototypeId: `proto-${1790000000 + Math.floor(r() * 9999999)}-abc${Math.floor(r() * 999)}`,
        ...(r() < 0.5 ? { width: 1 + Math.floor(r() * 1280) } : {}),
        ...(r() < 0.5 ? { height: 1 + Math.floor(r() * 900) } : {}),
      }),
      children: false,
    },
    // `<map/>`: empty data (what it shows is derived from the page's places on
    // render), and `body: "none"` like `page-link`, so no children.
    { type: "map", data: () => ({}), children: false },
    // An AGENT-AUTHORED page — the one `page` a document can carry both ways.
    // Id-less below, it is the MINT form (`<agent-page title="…">body`); stamped,
    // it is the pointer plus body, and its id comes back as `ref` because
    // `<agent-page>` is an identified spelling. A HUMAN's page is absent on
    // purpose: `<page>` parses as a link, so it cannot round-trip here at all.
    {
      type: "page",
      data: (r) => ({
        title: `${words[Math.floor(r() * words.length)]!} "notes"`,
        icon: null,
        author: "agent" as const,
      }),
      children: true,
    },
  ];

  /**
   * A run opening with a declared claim line, and nothing before it. Only the
   * DEFAULT-TEXT type can ever be escaped — every other type emits its own
   * prefix first, so its line is claimed by itself — which is why this shape
   * only means anything on a `text` block.
   */
  function claimOpening(r: () => number): RichText {
    const claim = CLAIM_LINES[Math.floor(r() * CLAIM_LINES.length)]!;
    const body = words[Math.floor(r() * words.length)]!;
    return [{ text: r() < 0.3 ? claim : claim + " " + body }];
  }

  /** One table cell: a paragraph's text, or one of the table-only shapes. */
  function tableCell(r: () => number): RichText {
    const roll = r();
    if (roll < 0.15) return [];
    if (roll < 0.3) {
      const w = words[Math.floor(r() * words.length)]!;
      return [{ text: r() < 0.5 ? `${w}|${w}` : `| ${w} |` }];
    }
    if (roll < 0.38) return [{ text: r() < 0.5 ? "---" : ":-:" }];
    return pick(r);
  }

  function pick(r: () => number): RichText {
    // One text in four OPENS with a line another block type would claim. Both
    // halves of that are load-bearing:
    //
    //  - FIRST, because a claimer anchors at the line's start (or compares its
    //    `trim()`), so a marker anywhere else is just words;
    //  - UNMARKED, because the mark's own delimiters would be there first —
    //    `**3. x**` is claimed by nobody, and a generator that marked the claim
    //    would exercise the escape exactly as often as the old word list did.
    const claim =
      r() < 0.25
        ? CLAIM_LINES[Math.floor(r() * CLAIM_LINES.length)]!
        : undefined;
    const n = 1 + Math.floor(r() * 3);
    const parts: string[] = [];
    for (let i = 0; i < n; i++)
      parts.push(words[Math.floor(r() * words.length)]!);
    const marks =
      r() < 0.25
        ? ["bold" as const]
        : r() < 0.4
          ? ["italic" as const]
          : undefined;
    const body = parts.join(" ");
    if (claim === undefined)
      return [{ text: body, ...(marks ? { marks } : {}) }];
    // With marks the claim is its own leading run; without them it has to be
    // the SAME run as the words, or the parse coalesces two adjacent unmarked
    // runs back into one and the exact round trip would fail on a rewrite this
    // property is not about. Sometimes it is the whole text, which is the only
    // way to reach a claimer that reads the whole line (`divider` compares
    // `trim() === "---"`, so `--- alpha` is prose).
    if (marks) return [{ text: claim + " " }, { text: body, marks }];
    return [{ text: r() < 0.5 ? claim : claim + " " + body }];
  }

  const build = (r: () => number, depth: number): SerializedBlock => {
    const gen = gens[Math.floor(r() * gens.length)]!;
    const kids: SerializedBlock[] = [];
    if (gen.children && depth < 3) {
      const n = Math.floor(r() * (depth === 0 ? 3 : 2));
      for (let i = 0; i < n; i++) kids.push(build(r, depth + 1));
    }
    return {
      type: gen.type,
      data: gen.data(r),
      expanded: true,
      children: kids,
    };
  };

  return { claimLines: CLAIM_LINES, generators: gens, build };
}
