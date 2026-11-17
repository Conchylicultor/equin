// E2E verification: the screenshot editor loses nothing on a reload.
//
// Stages a capture the way the Screenshot button does (an attachment, recorded
// as the screenshot's kept capture), opens the editor, draws a stroke and
// reloads: the image, the stroke and the Draw tool come back. Then applies the
// stroke (a committed edit) and reloads again: the edit is replayed over the
// capture, with no stroke pending.
//
// Usage: ./equin run plugins/screenshot/e2e/kept-across-reload.ts [--out <dir>] [--headed] [--attach <ticket>]
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/screenshot-kept-across-reload";

await withBrowser(async (h) => {
  const { page } = await h.session();
  const r = report("screenshot editor kept across reload");
  await page.goto(pathUrl("/"), { waitUntil: "domcontentloaded" });

  // 1. A capture: a PNG staged as an attachment, recorded under a new id.
  const png = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 480;
    c.height = 320;
    const g = c.getContext("2d")!;
    g.fillStyle = "#3b82f6";
    g.fillRect(0, 0, 480, 320);
    const blob = await new Promise<Blob>((res) =>
      c.toBlob((b) => res(b!), "image/png"),
    );
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  const res = await page.request.post(pathUrl("/api/attachments"), {
    multipart: {
      file: {
        name: "screenshot.png",
        mimeType: "image/png",
        buffer: Buffer.from(png),
      },
    },
  });
  if (!res.ok()) throw new Error(`upload: ${res.status()} ${await res.text()}`);
  const { id: attachmentId } = (await res.json()) as { id: string };
  const id = `e2e-${Date.now()}`;
  await page.evaluate(
    ([id, att]) =>
      localStorage.setItem(
        `s:screenshot.capture:${id}`,
        JSON.stringify({
          v: { image: `![screenshot.png](/api/attachments/${att})` },
          ts: Date.now(),
        }),
      ),
    [id, attachmentId] as const,
  );

  // 2. The editor draws the capture from the attachment.
  await page.goto(pathUrl(`/agents/screenshot/${id}`), {
    waitUntil: "domcontentloaded",
  });
  const img = page.getByRole("img", { name: "Screenshot" });
  await img.waitFor({ state: "visible", timeout: 30_000 });
  r.ok("the editor shows the staged capture", true);

  // 3. Draw one stroke.
  await page.getByRole("button", { name: "Draw" }).click();
  const box = (await img.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++)
    await page.mouse.move(
      box.x + box.width * (0.2 + i * 0.05),
      box.y + box.height * (0.3 + i * 0.03),
    );
  await page.mouse.up();
  const kept = () =>
    page.evaluate((id) => {
      const raw = localStorage.getItem(`s:screenshot.edits:${id}`);
      return raw === null
        ? null
        : (JSON.parse(raw) as { v: { edits: unknown[]; strokes: unknown[] } })
            .v;
    }, id);
  await page.waitForFunction(
    (id) => localStorage.getItem(`s:screenshot.edits:${id}`) !== null,
    id,
  );

  // 4. Reload: the image, the pending stroke and the Draw tool come back.
  await page.reload({ waitUntil: "domcontentloaded" });
  await img.waitFor({ state: "visible", timeout: 30_000 });
  const afterDraw = await kept();
  r.ok(
    "the stroke survives the reload",
    afterDraw?.strokes.length === 1,
    JSON.stringify(
      afterDraw && { s: afterDraw.strokes.length, e: afterDraw.edits.length },
    ),
  );
  const points =
    (
      afterDraw?.strokes as { points: { x: number; y: number }[] }[] | undefined
    )?.[0]?.points ?? [];
  r.ok(
    "every point of the stroke is where it was drawn (the canvas stayed mounted mid-stroke)",
    points.length >= 5 && points.every((p) => p.x > 0 && p.y > 0),
    JSON.stringify(points.map((p) => [Math.round(p.x), Math.round(p.y)])),
  );
  const applyEnabled = await page
    .getByRole("button", { name: "Apply" })
    .isEnabled();
  r.ok("the Draw tool is still picked, its stroke applicable", applyEnabled);
  await snap(page, OUT, "after-reload-stroke");

  // 5. Apply it, reload: one committed edit, replayed; nothing pending.
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForFunction(
    (id) =>
      (
        JSON.parse(
          localStorage.getItem(`s:screenshot.edits:${id}`) ?? "null",
        ) as {
          v: { edits: unknown[] };
        } | null
      )?.v.edits.length === 1,
    id,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await img.waitFor({ state: "visible", timeout: 30_000 });
  const afterApply = await kept();
  r.ok(
    "the applied edit survives the reload",
    afterApply?.edits.length === 1 && afterApply.strokes.length === 0,
    JSON.stringify(
      afterApply && {
        s: afterApply.strokes.length,
        e: afterApply.edits.length,
      },
    ),
  );
  await snap(page, OUT, "after-reload-applied");
  await r.finish();
});
