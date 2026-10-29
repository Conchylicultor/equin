/**
 * Probes content isolation (Trust boundaries, Phase 3 —
 * research/2026-10-29-global-content-isolation.md, Verification) against this
 * checkout's deploy.
 *
 * A HOSTILE prototype is minted into the prototypes dir for the run (removed
 * after it, pass or fail) and opened in this deploy's prototype canvas, which
 * frames it through `ContentFrame` on the content host
 * (`<id>.content.localhost`). Its document tries everything an untrusted page
 * on the owner's origin could do — read `top`, call the app's API as the
 * owner, open a socket, navigate the app away, script an app window, read the
 * app's storage, register a Service Worker — and records each outcome. Every
 * attack row must be DENIED. Its own files and storage must still work
 * (positive rows), and the canvas must still talk to it (its colour var painted
 * through the frame agent's channel).
 *
 * From outside: a content route asked for on the app origin answers
 * `403 content-only`. (What the content host refuses — the shell, `/gateway`,
 * sockets, Service Worker scripts — is the gateway's own `content_test.go`.)
 *
 * Negative control: the very same script, evaluated in the app page's own
 * realm (what an `allow-same-origin` frame on our origin used to be), must
 * REACH `top` and the owner API — so the probe can tell the two apart.
 *
 *   ./equin run plugins/primitives/plugins/embed/plugins/frame/e2e/content-probe.ts [--headed]
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  pageFetch,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { isContentHost } from "@plugins/infra/plugins/namespace/core";

const r = report("frame: content isolation probe");
const app = new URL(pathUrl("/"));

/** The attacks, as the hostile document runs them. `true` = denied. */
const ATTACKS = `
async function attacks(appOrigin) {
  const rows = {};
  const tryRow = async (name, fn) => {
    try { rows[name] = await fn(); }
    catch (e) { rows[name] = { denied: true, how: String(e && e.name || e) }; }
  };
  await tryRow("read top.document", async () => {
    const t = window.top.document.title;
    return { denied: false, how: "read " + JSON.stringify(t) };
  });
  await tryRow("read top.location", async () => {
    const h = window.top.location.href;
    return { denied: false, how: h };
  });
  await tryRow("owner API on the app origin (cors read)", async () => {
    const res = await fetch(appOrigin + "/api/host/routes", { credentials: "include" });
    return { denied: res.status !== 200, how: "status " + res.status };
  });
  await tryRow("owner API through the content host", async () => {
    const res = await fetch(new URL("../../host/routes", location.href).href);
    return { denied: res.status !== 200, how: "status " + res.status };
  });
  await tryRow("app socket", () => new Promise((done) => {
    const s = new WebSocket(appOrigin.replace(/^http/, "ws") + "/ws/notifications");
    s.onopen = () => { s.close(); done({ denied: false, how: "opened" }); };
    s.onerror = () => done({ denied: true, how: "error" });
  }));
  await tryRow("content-host socket", () => new Promise((done) => {
    const s = new WebSocket(new URL("../../../ws/notifications", location.href).href.replace(/^http/, "ws"));
    s.onopen = () => { s.close(); done({ denied: false, how: "opened" }); };
    s.onerror = () => done({ denied: true, how: "error" });
  }));
  await tryRow("script an app window it opened", async () => {
    const w = window.open(appOrigin + "/", "_blank");
    if (!w) return { denied: true, how: "popup blocked" };
    try { const t = w.document.title; w.close(); return { denied: false, how: "read " + t }; }
    finally { try { w.close(); } catch (e) { /* closed */ } }
  });
  await tryRow("app storage", async () => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("s:"));
    return { denied: keys.length === 0, how: keys.length + " app keys" };
  });
  await tryRow("register a Service Worker", async () => {
    if (!navigator.serviceWorker) return { denied: true, how: "no API" };
    await navigator.serviceWorker.register("probe-sw.js");
    return { denied: false, how: "registered" };
  });
  await tryRow("navigate the app away", async () => {
    window.top.location.href = "about:blank#taken";
    return { denied: false, how: "assigned" };
  });
  return rows;
}
`;

/** What the hostile prototype's own document checks it still has. */
const OWN = `
async function own() {
  const rows = {};
  try { const res = await fetch("probe.css"); rows["own file"] = res.status === 200; }
  catch (e) { rows["own file"] = false; }
  try { localStorage.setItem("probe", "1"); rows["own storage"] = localStorage.getItem("probe") === "1"; }
  catch (e) { rows["own storage"] = false; }
  return rows;
}
`;

function hostileHtml(appOrigin: string): string {
  return `<!doctype html>
<html lang="en" style="--probe-accent: #112233">
<head>
<meta charset="utf-8">
<title>Content isolation probe</title>
<link rel="stylesheet" href="probe.css">
</head>
<body>
<p>hostile prototype</p>
<script>
${ATTACKS}
${OWN}
window.__probe = { done: false };
(async () => {
  const rows = await attacks(${JSON.stringify(appOrigin)});
  const mine = await own();
  window.__probe = { done: true, rows, own: mine };
})();
</script>
</body>
</html>`;
}

const id = protoIdKind.mint();
const folder = join(prototypesDir.path, id);

async function main(): Promise<void> {
  mkdirSync(folder, { recursive: false });
  writeFileSync(join(folder, "index.html"), hostileHtml(app.origin));
  writeFileSync(
    join(folder, "probe.css"),
    "p { color: var(--probe-accent); }\n",
  );
  writeFileSync(
    join(folder, "probe-sw.js"),
    "self.addEventListener('fetch', () => {});\n",
  );
  r.note(`hostile prototype ${id} at ${folder}`);

  await withBrowser(async (h) => {
    const owner = await h.session({ label: "owner" });
    const page = owner.page;
    await page.goto(pathUrl(`/prototypes/proto/${id}`), {
      waitUntil: "domcontentloaded",
    });

    // The frame on the content host, once its document has run the attacks.
    const deadline = Date.now() + 60_000;
    let frame = page.frames().find((f) => isContentFrameOf(f.url()));
    while (!frame && Date.now() < deadline) {
      await page.waitForTimeout(250);
      frame = page.frames().find((f) => isContentFrameOf(f.url()));
    }
    if (!frame) {
      r.ok(
        "the canvas frames the prototype on the content host",
        false,
        "no frame on the content host",
      );
      return;
    }
    r.ok(
      "the canvas frames the prototype on the content host",
      true,
      frame.url(),
    );
    await frame.waitForFunction(
      () => (window as unknown as { __probe: { done: boolean } }).__probe.done,
      undefined,
      { timeout: 30_000 },
    );
    const result = (await frame.evaluate(
      () => (window as unknown as { __probe: unknown }).__probe,
    )) as {
      rows: Record<string, { denied: boolean; how: string }>;
      own: Record<string, boolean>;
    };
    for (const [name, row] of Object.entries(result.rows)) {
      r.ok(`content frame: ${name} — denied`, row.denied, row.how);
    }
    for (const [name, ok] of Object.entries(result.own)) {
      r.ok(`content frame: ${name} — still works`, ok, "");
    }
    r.ok(
      "the app was not navigated away",
      page.url().startsWith(app.origin),
      page.url(),
    );

    // The canvas still talks to it: the frame agent answered the channel
    // (screen height set on <html> by the agent).
    const screenVar = await frame.evaluate(() =>
      document.documentElement.style.getPropertyValue(
        "--prototype-screen-height",
      ),
    );
    r.ok(
      "the canvas reaches the frame over its channel",
      screenVar !== "",
      `--prototype-screen-height: ${screenVar || "(unset)"}`,
    );

    // From outside.
    const onApp = await pageFetch(page, `/api/prototypes/${id}/index.html`);
    const onAppBody = (await onApp.json()) as { reason?: string };
    r.eq(
      "a content route on the app origin -> 403 content-only",
      `${String(onApp.status)} ${onAppBody.reason ?? ""}`,
      "403 content-only",
    );
    // Negative control: the same two reads, from the app's own realm (what
    // an `allow-same-origin` frame on our origin was), reach what the
    // content frame could not — so the rows above can fail.
    const title = await page.evaluate(() => window.top?.document.title ?? null);
    const routes = await pageFetch(page, "/api/host/routes");
    const control = { title, status: routes.status };
    r.ok(
      "control (app realm): read top.document — reached",
      control.title !== null,
      JSON.stringify(control.title),
    );
    r.ok(
      "control (app realm): owner API on the app origin — reached",
      control.status === 200,
      `status ${String(control.status)}`,
    );
  });
}

function isContentFrameOf(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      isContentHost(u.host) && u.pathname.includes(`/api/prototypes/${id}/`)
    );
  } catch (err) {
    if (err instanceof TypeError) return false;
    throw err;
  }
}

try {
  await main();
} finally {
  rmSync(folder, { recursive: true, force: true });
  rmSync(join(prototypesDir.path, "_history", `${id}.git`), {
    recursive: true,
    force: true,
  });
}
await r.finish();
