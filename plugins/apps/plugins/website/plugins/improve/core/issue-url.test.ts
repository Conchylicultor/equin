import { describe, expect, test } from "bun:test";
import {
  serializeUiContext,
  type UiContextMeta,
} from "@plugins/primitives/plugins/ui-context/core";
import {
  buildIssueUrl,
  issueTitle,
  MAX_ISSUE_URL_LENGTH,
  readableIdea,
} from "./issue-url";

const REPO = "https://github.com/owner/repo";
const PAGE = "https://equin.ai/website/harness";

const HEADLINE: UiContextMeta = {
  url: "https://equin.ai/",
  path: "apps/website/landing/hero@Website.Section",
  element: "h1 — What will apps evolve into?",
  selector: "main>section>h1",
  source:
    "plugins/apps/plugins/website/plugins/landing/plugins/hero/web/hero.tsx:42",
};
const BUTTON: UiContextMeta = {
  url: "https://equin.ai/",
  element: "button — Show me",
};

/** A pick as the editor holds it: the tag the element picker inserts. */
const tag = (meta: UiContextMeta) => serializeUiContext(meta, "picked");

/** A pick whose tag alone is about `size` characters long, encoded. */
const bulkyPick = (label: string, size: number) =>
  tag({ url: "u", path: "a".repeat(size), element: label });

function parse(url: string) {
  const parsed = new URL(url);
  return {
    path: `${parsed.origin}${parsed.pathname}`,
    title: parsed.searchParams.get("title"),
    body: parsed.searchParams.get("body") ?? "",
    labels: parsed.searchParams.get("labels"),
  };
}

describe("issueTitle", () => {
  test("is the first non-empty line, trimmed", () => {
    expect(issueTitle("\n  \n  Show a demo  \nunder the headline")).toBe(
      "Show a demo",
    );
  });

  test("keeps a line of exactly 72 characters whole", () => {
    const line = "x".repeat(72);
    expect(issueTitle(line)).toBe(line);
  });

  test("cuts a longer line to 72 characters, ellipsis included", () => {
    const title = issueTitle("y".repeat(200));
    expect(Array.from(title)).toHaveLength(72);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("y".repeat(71))).toBe(true);
  });

  test("never halves an emoji at the cut", () => {
    const title = issueTitle("🙂".repeat(100));
    expect(title).toBe(`${"🙂".repeat(71)}…`);
  });
});

describe("readableIdea", () => {
  test("turns each tag into its label and number, in reading order", () => {
    const idea = readableIdea(
      `Make ${tag(HEADLINE)} bigger,\nand ${tag(BUTTON)} blue.`,
    );
    expect(idea.text).toBe(
      "Make `h1 — What will apps evolve into?` [1] bigger,\nand `button — Show me` [2] blue.",
    );
    expect(idea.picks).toEqual([
      {
        n: 1,
        label: HEADLINE.element,
        tag: tag(HEADLINE),
        file: "hero.tsx",
      },
      // No source stamped, so no file — not an empty one.
      { n: 2, label: BUTTON.element, tag: tag(BUTTON) },
    ]);
  });

  test("leaves a tag the parser refuses as typed, and does not number it", () => {
    const broken = `<ui-context plugin="p"><hint>h</hint><picked-content>div</picked-content></ui-context>`;
    const idea = readableIdea(`${broken} then ${tag(BUTTON)}`);
    expect(idea.text).toBe(`${broken} then \`button — Show me\` [1]`);
    expect(idea.picks.map((pick) => pick.n)).toEqual([1]);
  });

  test("fences a label holding backticks so it stays one code span", () => {
    const idea = readableIdea(
      tag({ url: "u", element: "code — `x` and ``y``" }),
    );
    expect(idea.text).toBe("``` code — `x` and ``y`` ``` [1]");
  });
});

describe("buildIssueUrl", () => {
  test("opens the repo's new-issue form with the title, body and label", () => {
    const url = buildIssueUrl({
      repoUrl: REPO,
      text: "Show a 20-second demo\nunder the headline",
      pageUrl: PAGE,
      autoDeploy: false,
    });
    const { path, title, body, labels } = parse(url);
    expect(path).toBe(`${REPO}/issues/new`);
    expect(title).toBe("Show a 20-second demo");
    expect(labels).toBe("idea");
    expect(body).toBe(
      [
        "Show a 20-second demo\nunder the headline",
        "",
        "---",
        `Page: ${PAGE}`,
        "Auto-deploy: no (review first)",
        "Filed from the Wish button on equin.ai",
      ].join("\n"),
    );
  });

  test("records the auto-deploy choice", () => {
    const { body } = parse(
      buildIssueUrl({
        repoUrl: REPO,
        text: "x",
        pageUrl: PAGE,
        autoDeploy: true,
      }),
    );
    expect(body).toContain("\nAuto-deploy: yes\n");
  });

  test("tolerates a trailing slash on the repo URL", () => {
    const url = buildIssueUrl({
      repoUrl: `${REPO}/`,
      text: "x",
      pageUrl: PAGE,
      autoDeploy: false,
    });
    expect(parse(url).path).toBe(`${REPO}/issues/new`);
  });

  test("encodes characters that would otherwise break the query", () => {
    const text = "a & b = c? #1 100% + more\nline two / \"quoted\" 'é' 🙂";
    const pageUrl = `${PAGE}?tab=a&x=1#section`;
    const url = buildIssueUrl({
      repoUrl: REPO,
      text,
      pageUrl,
      autoDeploy: false,
    });
    // One query string, no fragment: every reserved character in the text and
    // the page URL is escaped, so nothing ends a parameter early.
    expect(new URL(url).hash).toBe("");
    expect([...new URL(url).searchParams.keys()]).toEqual([
      "title",
      "body",
      "labels",
    ]);
    const { title, body } = parse(url);
    expect(title).toBe("a & b = c? #1 100% + more");
    expect(body.startsWith(`${text}\n\n---\nPage: ${pageUrl}\n`)).toBe(true);
  });

  test("stays under the cap for very long text, keeping the footer whole", () => {
    const text = `First line\n${"lorem ipsum dolor ".repeat(2_000)}`;
    const url = buildIssueUrl({
      repoUrl: REPO,
      text,
      pageUrl: PAGE,
      autoDeploy: true,
    });
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    const { title, body } = parse(url);
    expect(title).toBe("First line");
    const [kept] = body.split("\n\n---\n");
    expect(kept?.endsWith("…")).toBe(true);
    expect(text.startsWith(kept!.slice(0, -1))).toBe(true);
    expect(body).toContain(`Page: ${PAGE}`);
    expect(body).toContain("Auto-deploy: yes");
    // Tight, not merely under: one more character would not have fitted.
    expect(url.length).toBeGreaterThan(MAX_ISSUE_URL_LENGTH - 20);
  });

  test("measures the cap in encoded characters, not typed ones", () => {
    // Each emoji encodes to twelve characters, so a text far shorter than the
    // cap in characters is still far over it once encoded.
    const text = "🙂".repeat(1_500);
    const url = buildIssueUrl({
      repoUrl: REPO,
      text,
      pageUrl: PAGE,
      autoDeploy: false,
    });
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    expect(parse(url).body).not.toContain("�");
  });

  test("titles the issue with the readable text, never a raw tag", () => {
    const { title } = parse(
      buildIssueUrl({
        repoUrl: REPO,
        text: `${tag(BUTTON)} should be blue`,
        pageUrl: PAGE,
        autoDeploy: false,
      }),
    );
    expect(title).toBe("`button — Show me` [1] should be blue");
    expect(issueTitle(`${tag(HEADLINE)}`)).toBe(
      "`h1 — What will apps evolve into?` [1]",
    );
  });

  test("carries each pick's raw tag in a collapsed, fenced block", () => {
    const url = buildIssueUrl({
      repoUrl: REPO,
      text: `Make ${tag(HEADLINE)} bigger,\nand ${tag(BUTTON)} blue.`,
      pageUrl: PAGE,
      autoDeploy: false,
    });
    expect(parse(url).body).toBe(
      [
        "Make `h1 — What will apps evolve into?` [1] bigger,",
        "and `button — Show me` [2] blue.",
        "",
        "---",
        "<details><summary>[1] h1 — What will apps evolve into?</summary>",
        "",
        "```html",
        tag(HEADLINE),
        "```",
        "",
        "</details>",
        "",
        "<details><summary>[2] button — Show me</summary>",
        "",
        "```html",
        tag(BUTTON),
        "```",
        "",
        "</details>",
        "",
        `Page: ${PAGE}`,
        "Auto-deploy: no (review first)",
        "Filed from the Wish button on equin.ai",
      ].join("\n"),
    );
  });

  test("uses a fence the tag's own backticks cannot close", () => {
    // Attribute values keep backticks (only quotes and whitespace are
    // sanitized), so a selector can carry a run of three.
    const picked = tag({ url: "u", element: "div", selector: "a```b" });
    const { body } = parse(
      buildIssueUrl({
        repoUrl: REPO,
        text: picked,
        pageUrl: PAGE,
        autoDeploy: false,
      }),
    );
    expect(body).toContain(`\n\`\`\`\`html\n${picked}\n\`\`\`\`\n`);
  });

  test("escapes the label where it is HTML: the block's summary", () => {
    const { body } = parse(
      buildIssueUrl({
        repoUrl: REPO,
        text: tag({ url: "u", element: "a — Q&A > FAQ" }),
        pageUrl: PAGE,
        autoDeploy: false,
      }),
    );
    expect(body).toContain("<summary>[1] a — Q&amp;A &gt; FAQ</summary>");
  });

  test("over the cap, drops raw tags first, last pick first", () => {
    const picks = [
      bulkyPick("h1 — One", 2_400),
      bulkyPick("h2 — Two", 2_400),
      bulkyPick("h3 — Three", 2_400),
    ];
    const text = `Swap ${picks[0]}, ${picks[1]} and ${picks[2]}`;
    const url = buildIssueUrl({
      repoUrl: REPO,
      text,
      pageUrl: PAGE,
      autoDeploy: false,
    });
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    const { body } = parse(url);
    // The text is whole: only a tag had to go.
    expect(body.startsWith(`${readableIdea(text).text}\n\n---\n`)).toBe(true);
    expect(body).toContain(
      `<summary>[1] h1 — One</summary>\n\n\`\`\`html\n${picks[0]}\n`,
    );
    expect(body).toContain(`<summary>[2] h2 — Two</summary>`);
    expect(body).not.toContain("<summary>[3]");
    expect(body).not.toContain(picks[2]!);
    // The pick that lost its tag is still listed, after the blocks.
    expect(body).toContain("</details>\n\n[3] h3 — Three\n\nPage: ");
  });

  test("keeps the text whole while any tag can still go", () => {
    // Every tag is over the cap on its own, so all of them go, and nothing else.
    const text = `Swap ${bulkyPick("h1 — One", 8_000)} for ${bulkyPick("h2 — Two", 8_000)}`;
    const { body } = parse(
      buildIssueUrl({ repoUrl: REPO, text, pageUrl: PAGE, autoDeploy: false }),
    );
    expect(body).toBe(
      [
        "Swap `h1 — One` [1] for `h2 — Two` [2]",
        "",
        "---",
        "[1] h1 — One",
        "[2] h2 — Two",
        "",
        `Page: ${PAGE}`,
        "Auto-deploy: no (review first)",
        "Filed from the Wish button on equin.ai",
      ].join("\n"),
    );
  });

  test("with every tag gone, cuts the text next, keeping every [n] line", () => {
    const text = `Move ${tag(HEADLINE)} under ${tag(BUTTON)}\n${"lorem ipsum ".repeat(2_000)}`;
    const url = buildIssueUrl({
      repoUrl: REPO,
      text,
      pageUrl: PAGE,
      autoDeploy: true,
    });
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    expect(url.length).toBeGreaterThan(MAX_ISSUE_URL_LENGTH - 20);
    const { title, body } = parse(url);
    expect(title).toBe(
      "Move `h1 — What will apps evolve into?` [1] under `button — Show me` [2]",
    );
    expect(body).not.toContain("<details>");
    expect(body).not.toContain("<ui-context");
    const [kept, rest] = body.split("\n\n---\n");
    expect(kept?.endsWith("…")).toBe(true);
    expect(readableIdea(text).text.startsWith(kept!.slice(0, -1))).toBe(true);
    expect(
      rest?.startsWith(
        "[1] h1 — What will apps evolve into?\n[2] button — Show me\n\nPage: ",
      ),
    ).toBe(true);
  });

  test("with the text gone too, lists the first picks and counts the rest", () => {
    const picks = Array.from({ length: 30 }, (_, i) =>
      tag({ url: "u", element: `div — ${i + 1} ${"x".repeat(400)}` }),
    );
    const url = buildIssueUrl({
      repoUrl: REPO,
      text: picks.join(" "),
      pageUrl: PAGE,
      autoDeploy: false,
    });
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    const { body } = parse(url);
    const [kept, rest = ""] = body.split("\n\n---\n");
    expect(kept).toBe("…");
    const [section = ""] = rest.split("\n\nPage: ");
    const lines = section.split("\n");
    const listed = lines.slice(0, -1);
    // The first picks, in order, then one count for everything after them.
    expect(listed.length).toBeGreaterThan(0);
    listed.forEach((line, i) =>
      expect(line.startsWith(`[${i + 1}] div — ${i + 1} x`)).toBe(true),
    );
    expect(lines.at(-1)).toBe(`+${30 - listed.length} more`);
  });

  test("throws when the page URL alone is over the cap", () => {
    expect(() =>
      buildIssueUrl({
        repoUrl: REPO,
        text: "x".repeat(10_000),
        pageUrl: `${PAGE}?q=${"z".repeat(MAX_ISSUE_URL_LENGTH)}`,
        autoDeploy: false,
      }),
    ).toThrow(/no text at all/);
  });
});
