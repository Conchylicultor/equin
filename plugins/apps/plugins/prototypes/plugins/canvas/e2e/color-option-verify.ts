// Verifies a `color` option end to end: picking a suggestion repaints frame A
// without loading a new document; dragging the picker's square changes the
// document's computed `--<option>` on every move while the frame's `src` stays
// put and nothing is written; releasing writes the shared record exactly once;
// a reload reopens on the pick; and the document URL of that variant renders
// the color server-stamped into `<html style>`. Manual only — nothing runs
// this automatically. The harness reverts what this run wrote to the shared
// picks record.
//
// It needs a prototype declaring a color option with 2+ suggestions:
// `--name <id>`, else the first such prototype on this deploy. With
// `--make-fixture` it mints one first (through `POST /api/prototypes`, then
// writes the fixture page into its folder) and prints its id — a real
// prototype, left in the gallery for the next run.
//
// Usage:
//   ./equin run plugins/apps/plugins/prototypes/plugins/canvas/e2e/color-option-verify.ts \
//     [--name <prototype id> | --make-fixture] [--out <prefix>] [--headed]

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import {
  pageFetch,
  agentFetch,
  arg,
  flag,
  report,
  snap,
  usage,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import {
  humanizeToken,
  type ColorOption,
  type PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { canvasFrameSelector } from "@plugins/apps/plugins/prototypes/plugins/canvas/core";
import {
  dismiss,
  frameColor,
  openCanvas,
  openOptions,
  pickValue,
} from "./driver";

const out = arg("out", "/tmp/color-option-verify");

/** The fixture page: one color option, three suggestions, the default in `<html style>`. */
const FIXTURE_HTML = `<!doctype html>
<html lang="en" style="--accent: #7c5cff">
<head>
<meta charset="utf-8" />
<title>Color option fixture</title>
<meta name="description" content="E2E fixture for the color option kind (color-option-verify.ts)." />
<meta name="prototype-viewport" content="responsive" />
<meta name="prototype-option" content="accent: color violet=#7c5cff | azure=#3b82f6 | mint=#10b981" />
<style>
  html, body { margin: 0; height: 100%; font-family: system-ui, sans-serif; }
  body { display: grid; place-items: center; background: color-mix(in oklab, var(--accent) 12%, white); }
  .cta { padding: 16px 28px; border-radius: 12px; color: white; background: var(--accent); font-size: 20px; }
</style>
</head>
<body><div class="cta">Start a session</div></body>
</html>
`;

async function listMetas(): Promise<PrototypeMeta[]> {
  const res = await agentFetch("/api/prototypes");
  if (!res.ok) throw new Error(`GET /api/prototypes → ${res.status}`);
  return (await res.json()) as PrototypeMeta[];
}

function colorOptionOf(meta: PrototypeMeta): ColorOption | undefined {
  return meta.options.find(
    (o): o is ColorOption => o.kind === "color" && o.suggestions.length >= 2,
  );
}

/** Mint a prototype and write the fixture page into it; its meta once listed. */
async function makeFixture(): Promise<PrototypeMeta> {
  const res = await agentFetch("/api/prototypes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Color option fixture" }),
  });
  if (!res.ok) throw new Error(`POST /api/prototypes → ${res.status}`);
  const { id } = (await res.json()) as { id: string };
  writeFileSync(join(prototypesDir.path, id, "index.html"), FIXTURE_HTML);
  console.log(`minted fixture prototype ${id}`);
  const listed = await waitFor(
    async () => (await listMetas()).find((m) => m.name === id),
    (m) => m !== undefined && colorOptionOf(m) !== undefined,
    { timeoutMs: 20_000 },
  );
  if (!listed.ok || !listed.value) {
    throw new Error(`fixture ${id} never listed with its color option`);
  }
  return listed.value;
}

async function pickMeta(): Promise<PrototypeMeta> {
  if (flag("make-fixture")) return makeFixture();
  const rows = await listMetas();
  const wanted = arg("name");
  const meta = wanted
    ? rows.find((p) => p.name === wanted)
    : rows.find((p) => colorOptionOf(p) !== undefined);
  if (!meta || colorOptionOf(meta) === undefined) {
    usage(
      wanted
        ? `prototype "${wanted}" is not on this deploy, or declares no color option with 2+ suggestions`
        : "no prototype on this deploy declares a color option with 2+ suggestions — pass --make-fixture to mint one",
    );
  }
  return meta;
}

const meta = await pickMeta();
const option = colorOptionOf(meta)!;
const label = humanizeToken(option.name);

/** Frame A's document element(s): the iframes inside its screen. */
async function frameASrcs(page: Page): Promise<string[]> {
  return page
    .locator(`${canvasFrameSelector({ letter: "A" })} iframe`)
    .evaluateAll((els) => els.map((el) => el.getAttribute("src") ?? ""));
}

/** The shared picks record as the server reads it now. */
async function readStoredPicks(page: Page): Promise<Record<string, string>> {
  const res = await pageFetch(
    page,
    `/api/resources/prototypes.picks?${new URLSearchParams({ name: meta.name }).toString()}`,
  );
  if (!res.ok) throw new Error(`prototypes.picks read: HTTP ${res.status}`);
  const body = (await res.json()) as { value: Record<string, string> };
  return body.value;
}

/** Every PUT of this prototype's picks the page has sent. */
const puts: string[] = [];

/** Drag across `area` from its centre towards its top-right, sampling after each move. */
async function dragArea(
  page: Page,
  area: Locator,
  sample: () => Promise<string | null>,
): Promise<{ samples: (string | null)[]; putsBeforeUp: number }> {
  const box = await area.boundingBox();
  if (!box) throw new Error("the color area has no box");
  const x0 = box.x + box.width / 2;
  const y0 = box.y + box.height / 2;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  const samples: (string | null)[] = [];
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(
      x0 + (i * box.width) / 16,
      y0 - (i * box.height) / 16,
      { steps: 2 },
    );
    await page.waitForTimeout(120);
    samples.push(await sample());
  }
  const putsBeforeUp = puts.length;
  await page.mouse.up();
  return { samples, putsBeforeUp };
}

await withBrowser(async (h) => {
  const r = report(
    `color option — ${meta.title} (${meta.name}), option ${option.name}`,
  );
  const { page, captured } = await h.session({
    viewport: { width: 1600, height: 1000 },
  });
  page.on("request", (req) => {
    if (
      req.method() === "PUT" &&
      req.url().includes(`/api/prototypes/${meta.name}/picks`)
    ) {
      puts.push(req.postData() ?? "");
    }
  });
  await openCanvas(page, meta.name);

  // Start from the defaults, so the suggestion picked below is a change.
  let popover = await openOptions(page, "A");
  const reset = popover.getByRole("button", { name: "Reset to defaults" });
  if ((await reset.count()) > 0) await reset.click();
  const atDefault = await waitFor(
    () => frameColor(page, "A", option.name),
    (c) => c === option.default,
    { timeoutMs: 10_000 },
  );
  r.eq("frame A starts on the default color", atDefault.value, option.default);

  // ── A suggestion: repaints, no new document ────────────────────────────
  const target =
    option.suggestions.find((s) => s.color !== option.default) ??
    option.suggestions[0]!;
  const srcsBefore = await frameASrcs(page);
  const putsBefore = puts.length;
  await pickValue(popover, label, humanizeToken(target.name));
  const repainted = await waitFor(
    () => frameColor(page, "A", option.name),
    (c) => c === target.color,
    { timeoutMs: 10_000 },
  );
  r.eq(
    `picking ${target.name} repaints frame A`,
    repainted.value,
    target.color,
  );
  r.eq(
    "the suggestion loads no new document (frame A's src is unchanged)",
    await frameASrcs(page),
    srcsBefore,
  );
  r.eq("the suggestion writes the record once", puts.length - putsBefore, 1);
  await snap(page, out, "suggestion");

  // ── A drag: every move repaints, nothing written until release ──────────
  await popover
    .getByRole("button", { name: `Pick any ${label.toLowerCase()} color` })
    .click();
  // The picker opens in its own popover (portaled beside the options one).
  const area = page.getByRole("slider", { name: "Lightness and chroma" });
  await area.waitFor({ state: "visible", timeout: 5000 });
  await snap(page, out, "picker-open");
  const putsBeforeDrag = puts.length;
  const { samples, putsBeforeUp } = await dragArea(page, area, () =>
    frameColor(page, "A", option.name),
  );
  console.log(`--${option.name} during the drag: ${samples.join(" → ")}`);
  r.ok(
    "the frame repaints while dragging (the color moves between samples)",
    new Set(samples).size >= 3,
    samples.join(", "),
  );
  r.eq(
    "dragging loads no new document (frame A's src is unchanged)",
    await frameASrcs(page),
    srcsBefore,
  );
  r.eq("nothing is written while dragging", putsBeforeUp - putsBeforeDrag, 0);
  const committed = await waitFor(
    async () => puts.length - putsBeforeDrag,
    (n) => n >= 1,
    { timeoutMs: 5000 },
  );
  await page.waitForTimeout(500);
  r.eq(
    "releasing writes the record exactly once",
    puts.length - putsBeforeDrag,
    1,
  );
  r.ok("the release was written", committed.ok);
  const finalColor = await frameColor(page, "A", option.name);
  const stored = await waitFor(
    () => readStoredPicks(page),
    (p) => p[option.name] === finalColor,
    { timeoutMs: 10_000 },
  );
  r.ok(
    "the shared record stores the dragged color as #rrggbb",
    stored.ok && /^#[0-9a-f]{6}$/.test(stored.value?.[option.name] ?? ""),
    JSON.stringify(stored.value),
  );
  await snap(page, out, "dragged");
  await dismiss(page);

  // ── Reload: the pick persisted, and the document arrives stamped ────────
  await page.reload();
  const reloaded = await waitFor(
    () => frameColor(page, "A", option.name),
    (c) => c === finalColor,
    { timeoutMs: 20_000 },
  );
  r.eq("after a reload frame A shows the pick", reloaded.value, finalColor);
  const src = (await frameASrcs(page))[0] ?? "";
  r.ok(
    "the reloaded document's src carries the color pick",
    new URL(src, "http://x").searchParams.get(option.name) === finalColor,
    src,
  );

  // ── The variant's document URL renders it, server-stamped ───────────────
  const doc = await agentFetch(
    `/api/prototypes/${meta.name}/index.html?${new URLSearchParams({ [option.name]: finalColor ?? "" }).toString()}`,
  );
  const html = await doc.text();
  r.ok(
    "the document URL stamps the color into <html style>",
    doc.ok && html.includes(`--${option.name}: ${finalColor}`),
    `${doc.status} ${/<html[^>]*>/.exec(html)?.[0] ?? ""}`,
  );
  console.log(
    `check by hand: ./equin prototype options ${meta.name} prints ${option.name}  ${finalColor}`,
  );

  // Open the picker once more for the screenshot of its popover.
  popover = await openOptions(page, "A");
  await popover
    .getByRole("button", { name: `Pick any ${label.toLowerCase()} color` })
    .click();
  await snap(page, out, "picker-popover");
  await dismiss(page);

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
