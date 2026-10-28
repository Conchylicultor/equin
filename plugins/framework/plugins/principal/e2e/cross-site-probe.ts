/**
 * Probes the HTTP-edge principal gate (research/2026-10-28-global-http-edge-principal.md,
 * Verification) against this checkout's deploy.
 *
 * Leg A (headers): raw HTTP with forged browser headers (`Origin:
 * https://evil.example`, `Sec-Fetch-Site: cross-site`). Every owner route in
 * both hosts' route tables, `/gateway/worktrees/<x>/restart`, a WebSocket
 * upgrade per ws route and a DNS-rebinding Host must be refused before any
 * handler runs. Public routes are listed, not probed. A header-less request
 * (a local tool = the owner) is the control. A host whose gateway does not
 * stamp the principal (route table `stamped: false`) fails the run at once:
 * its routes are served ungated by design.
 *
 * Leg B (real browser): Chromium opens an attacker page served from
 * 127.0.0.1:<random port>; it fires a no-cors fetch POST, an auto-submitted
 * form POST and a WebSocket at the deploy. All must be refused; the headers
 * Chromium actually sent are recorded. A same-origin fetch is the control.
 *
 *   ./equin run plugins/framework/plugins/principal/e2e/cross-site-probe.ts [--headed] [--url <origin>]
 */
import http from "node:http";
import {
  agentFetch,
  pageFetch,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  CENTRAL_HOST_ROUTES_ROUTE,
  HOST_ROUTES_ROUTE,
  HostRouteTableSchema,
  isCrossSiteRefusal,
} from "@plugins/framework/plugins/principal/core";
import type { HostRoute } from "@plugins/framework/plugins/principal/core";

const SENTINEL = "__probe__";
const EVIL = "https://evil.example";
const FORGED = {
  origin: EVIL,
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "cors",
};
const INSTALL_ROUTE = "POST /api/menu-bar/install/:appId";
const INSTALL_PATH = "/api/menu-bar/install/no-such-app-probe";

const r = report("principal: cross-site probe");
const target = new URL(pathUrl("/"));
/** Dial loopback directly; the Host header names the deploy (and is forgeable). */
const PORT = Number(target.port || 80);

interface Raw {
  status: number;
  body: string;
  /** The server accepted a WebSocket upgrade (101). */
  upgraded: boolean;
}

/** One raw HTTP request to the gateway, any headers (Host and Origin included). */
function raw(
  method: string,
  path: string,
  headers: Record<string, string>,
  upgrade = false,
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        path,
        headers: {
          host: target.host,
          ...(upgrade
            ? {
                connection: "Upgrade",
                upgrade: "websocket",
                "sec-websocket-version": "13",
                "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            upgraded: false,
          }),
        );
      },
    );
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 101, body: "", upgraded: true });
    });
    req.on("error", reject);
    req.end();
  });
}

function refused(res: Raw): boolean {
  let body: unknown;
  try {
    body = JSON.parse(res.body);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    body = res.body; // not JSON: cannot be the refusal body
  }
  return isCrossSiteRefusal(res.status, body);
}

function fill(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+\*?/g, SENTINEL);
}

async function readTable(route: string): Promise<HostRoute[]> {
  const [, path = ""] = route.split(" ");
  const res = await agentFetch(path);
  r.eq(
    `control: ${route} (no browser headers = local tool) -> 200`,
    res.status,
    200,
  );
  const table = HostRouteTableSchema.parse(await res.json());
  if (!table.stamped) {
    // Every route is served ungated behind a gateway older than the stamp:
    // probing would only report every route open, for a reason it can name.
    r.fail(
      `${route}: gateway not stamping — no --principal-stamped on this host's argv`,
      "this host serves every route ungated until the gateway is restarted: ./equin start --force",
    );
    return await r.finish();
  }
  return table.routes;
}

// ---------------------------------------------------------------- Leg A
async function legA(): Promise<void> {
  const tables: Array<[string, HostRoute[]]> = [
    ["server", await readTable(HOST_ROUTES_ROUTE)],
    ["central", await readTable(CENTRAL_HOST_ROUTES_ROUTE)],
  ];
  const all = tables.flatMap(([host, rows]) =>
    rows.map((row) => ({ host, ...row })),
  );

  r.ok(
    `F9: ${INSTALL_ROUTE} is in a route table`,
    all.some((row) => row.route === INSTALL_ROUTE),
    "not listed; the F9 probe below still runs",
  );

  for (const row of all.filter((x) => x.access === "public")) {
    r.note(
      `public (${row.host}, ${row.kind}) ${row.route} — ${row.reason ?? "?"}`,
    );
  }

  for (const row of all.filter((x) => x.access === "owner")) {
    if (row.kind === "http") {
      const [method = "GET", path = ""] = row.route.split(" ");
      const res = await raw(method, fill(path), FORGED);
      r.ok(
        `A ${row.host} ${row.route} cross-site -> 403 cross-site-refused`,
        refused(res),
        `got ${res.status} ${res.body.slice(0, 120)}`,
      );
    } else {
      const res = await raw("GET", fill(row.route), FORGED, true);
      r.ok(
        `A ${row.host} WS ${row.route} cross-site upgrade refused`,
        !res.upgraded && res.status === 403,
        `got ${res.upgraded ? "101 upgrade" : res.status}`,
      );
    }
  }

  const f9 = await raw("POST", INSTALL_PATH, FORGED);
  r.ok(
    "A F9: POST /api/menu-bar/install/no-such-app-probe cross-site -> 403 cross-site-refused (not the handler's 404)",
    refused(f9),
    `got ${f9.status} ${f9.body.slice(0, 120)}`,
  );

  const restart = await raw(
    "POST",
    `/gateway/worktrees/${SENTINEL}/restart`,
    FORGED,
  );
  r.ok(
    "A POST /gateway/worktrees/__probe__/restart cross-site -> 403 cross-site-refused",
    refused(restart),
    `got ${restart.status} ${restart.body.slice(0, 120)}`,
  );

  const ws = await raw("GET", "/ws/notifications", { origin: EVIL }, true);
  r.ok(
    "A WS /ws/notifications with Origin https://evil.example refused",
    !ws.upgraded && ws.status >= 400,
    `got ${ws.upgraded ? "101 upgrade" : ws.status}`,
  );

  const rebind = await raw("GET", "/api/host/routes", {
    host: "evil.example:9000",
    origin: "http://evil.example:9000",
    "sec-fetch-site": "same-origin",
  });
  r.ok(
    "A DNS rebinding (Host evil.example:9000, same-origin) GET /api/host/routes not 200",
    rebind.status !== 200,
    `got ${rebind.status}`,
  );
}

// ---------------------------------------------------------------- Leg B
interface Seen {
  kind: string;
  url: string;
  status: number | null;
  secFetchSite: string | undefined;
  origin: string | undefined;
}

const ATTACKER_HTML = (api: string, ws: string): string => `<!doctype html>
<meta charset="utf-8"><title>attacker</title>
<iframe name="sink" style="display:none"></iframe>
<form id="f" method="POST" action="${api}${INSTALL_PATH}" target="sink"></form>
<script>
  window.__ws = { opened: false, closed: false, errored: false };
  fetch(${JSON.stringify(api + INSTALL_PATH)}, { method: "POST", mode: "no-cors" })
    .catch(() => {});
  document.getElementById("f").submit();
  const s = new WebSocket(${JSON.stringify(ws)});
  s.onopen = () => { window.__ws.opened = true; };
  s.onerror = () => { window.__ws.errored = true; };
  s.onclose = () => { window.__ws.closed = true; };
</script>`;

async function legB(): Promise<void> {
  const api = target.origin;
  const wsUrl = `${target.protocol === "https:" ? "wss:" : "ws:"}//${target.host}/ws/notifications`;
  const attacker = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(ATTACKER_HTML(api, wsUrl), {
        headers: { "content-type": "text/html" },
      }),
  });
  try {
    await withBrowser(async (h) => {
      const seen: Seen[] = [];
      const victim = await h.session({ label: "attacker" });
      const page = victim.page;
      const interesting = (url: string): boolean =>
        new URL(url).host === target.host;
      page.on("request", (req) => {
        if (!interesting(req.url())) return;
        void req.allHeaders().then((hd) => {
          seen.push({
            kind: `request ${req.method()} ${req.resourceType()}`,
            url: req.url(),
            status: null,
            secFetchSite: hd["sec-fetch-site"],
            origin: hd["origin"],
          });
        });
      });
      page.on("response", (res) => {
        if (!interesting(res.url())) return;
        const req = res.request();
        seen.push({
          kind: `response ${req.method()} ${req.resourceType()}`,
          url: res.url(),
          status: res.status(),
          secFetchSite: undefined,
          origin: undefined,
        });
      });

      await page.goto(`http://127.0.0.1:${attacker.port}/`, {
        waitUntil: "load",
      });
      // The in-page WebSocket settles either way (open, or error then close).
      await page.waitForFunction(
        () => {
          const w = (
            window as unknown as { __ws: { opened: boolean; closed: boolean } }
          ).__ws;
          return w.opened || w.closed;
        },
        undefined,
        { timeout: 15_000 },
      );
      // Let the form POST and no-cors fetch responses land.
      await page.waitForTimeout(1500);

      for (const s of seen) {
        r.note(
          `Chromium sent: ${s.kind} ${s.url} status=${s.status ?? "-"} Sec-Fetch-Site=${s.secFetchSite ?? "-"} Origin=${s.origin ?? "-"}`,
        );
      }
      const statusOf = (type: string): number[] =>
        seen
          .filter(
            (s) =>
              s.kind.startsWith("response") &&
              s.kind.endsWith(type) &&
              s.url.includes(INSTALL_PATH),
          )
          .map((s) => s.status ?? 0);
      const fetches = statusOf("fetch");
      const forms = statusOf("document");
      r.ok(
        "B no-cors fetch POST install -> 403",
        fetches.length > 0 && fetches.every((s) => s === 403),
        `statuses ${JSON.stringify(fetches)}`,
      );
      r.ok(
        "B form POST install (hidden iframe) -> 403",
        forms.length > 0 && forms.every((s) => s === 403),
        `statuses ${JSON.stringify(forms)}`,
      );
      const ws = await page.evaluate(
        () =>
          (
            window as unknown as {
              __ws: { opened: boolean; errored: boolean; closed: boolean };
            }
          ).__ws,
      );
      r.ok(
        "B WebSocket /ws/notifications from attacker page never opens",
        !ws.opened && ws.closed,
        JSON.stringify(ws),
      );
      const stolen = seen.filter(
        (s) =>
          s.status !== null &&
          s.status < 400 &&
          !s.url.endsWith("/favicon.ico"),
      );
      r.ok(
        "B no request to the deploy succeeded (status < 400)",
        stolen.length === 0,
        JSON.stringify(stolen),
      );

      // Control: the deploy's own page, same-origin.
      const own = await h.session({ label: "owner" });
      await own.page.goto(pathUrl("/"), { waitUntil: "domcontentloaded" });
      // pageFetch rides the context's cookies/headers (lint forbids an in-page
      // fetch of the app's API); it sends no Sec-Fetch-Site, i.e. the
      // local-tool/owner path, so this proves the deploy is up and open to the
      // owner while the page is loaded.
      const res = await pageFetch(own.page, "/api/host/routes");
      r.eq(
        "B control: owner fetch /api/host/routes with the deploy's page loaded -> 200",
        res.status,
        200,
      );
    });
  } finally {
    await attacker.stop(true);
  }
}

await legA();
await legB();
await r.finish();
