// Computed-style dump of the agent manager's sidebar, for checking it against
// the Mist mockup's numbers (proto-1789643584-ldt6): every text run, icon and
// status dot with its x offset from the sidebar's edge, its box, and its font
// and colour. Read-only.
//
//   ./equin run plugins/apps/plugins/agent-manager/plugins/shell/e2e/sidebar-metrics.ts \
//     [--path /agents] [--url http://<ns>.localhost:9000/agents] [--color-scheme dark]

import {
  arg,
  pageUrl,
  withBrowser,
  type ColorScheme,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const url = pageUrl("/agents");
const colorScheme = (arg("color-scheme") ?? "dark") as ColorScheme;
console.log(`url: ${url}`);

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme,
  });
  await page.goto(url);
  await page.waitForTimeout(4000);
  const dump = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(
      '[data-slot="sidebar-container"], [data-sidebar="sidebar"]',
    );
    if (!sidebar) return { error: "no sidebar" };
    const s = sidebar.getBoundingClientRect();
    const round = (n: number) => Math.round(n * 10) / 10;
    const out: string[] = [
      `sidebar width=${round(s.width)} height=${round(s.height)}`,
    ];
    const describe = (el: Element, what: string) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return `${what} x=${round(r.left - s.left)} y=${round(r.top - s.top)} w=${round(r.width)} h=${round(r.height)} font=${cs.fontSize}/${cs.fontWeight} lh=${cs.lineHeight} color=${cs.color} bg=${cs.backgroundColor} border=${cs.borderTopWidth} ${cs.borderTopColor} radius=${cs.borderTopLeftRadius} pad=${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`;
    };
    for (const btn of sidebar.querySelectorAll(
      '[data-sidebar="menu-button"]',
    )) {
      out.push(
        describe(
          btn,
          `menu-button[${(btn.textContent ?? "").trim().slice(0, 24)}]${btn.hasAttribute("data-active") ? " ACTIVE" : ""}`,
        ),
      );
    }
    const walker = document.createTreeWalker(sidebar, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    let count = 0;
    while ((n = walker.nextNode()) && count < 60) {
      const text = (n.textContent ?? "").trim();
      if (!text || !n.parentElement) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width === 0) continue;
      const cs = getComputedStyle(n.parentElement);
      out.push(
        `text[${text.slice(0, 28)}] x=${round(r.left - s.left)} y=${round(r.top - s.top)} h=${round(r.height)} font=${cs.fontSize}/${cs.fontWeight} color=${cs.color}`,
      );
      count++;
    }
    let svgs = 0;
    for (const svg of sidebar.querySelectorAll("svg")) {
      if (svgs++ > 20) break;
      const r = svg.getBoundingClientRect();
      if (r.width === 0) continue;
      out.push(
        `svg x=${round(r.left - s.left)} y=${round(r.top - s.top)} size=${round(r.width)}x${round(r.height)} color=${getComputedStyle(svg).color}`,
      );
    }
    let dots = 0;
    for (const dot of sidebar.querySelectorAll(
      'span[class*="size-status-dot"]',
    )) {
      if (dots++ > 12) break;
      out.push(describe(dot, "dot"));
    }
    for (const row of Array.from(
      sidebar.querySelectorAll('[aria-current="true"]'),
    ).slice(0, 3)) {
      out.push(describe(row, "selected-row"));
    }
    return { lines: out };
  });
  if ("error" in dump) {
    console.error(dump.error);
    process.exitCode = 1;
    return;
  }
  for (const line of dump.lines) console.log(line);
});
