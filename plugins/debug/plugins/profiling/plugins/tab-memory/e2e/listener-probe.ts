// Probe: which event listeners an idle tab accumulates, and who adds them.
// Wraps EventTarget.prototype.add/removeEventListener before the app boots,
// keeps a live count per (target type, event type) and the stack of the
// latest additions, then reports the net growth over the soak.
//
//   ./equin run plugins/debug/plugins/profiling/plugins/tab-memory/e2e/listener-probe.ts \
//     [--url http://equin.localhost:9000] [--path /agents] [--minutes 5]
import {
  arg,
  numArg,
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const path = arg("path", "/agents");
const minutes = numArg("minutes", 5);

interface Probe {
  live: Record<string, number>;
  stacks: Record<string, Record<string, number>>;
}
type ProbeWindow = Window & { __lp?: Probe };

const read = (): Probe => {
  const p = (window as ProbeWindow).__lp!;
  return JSON.parse(JSON.stringify(p)) as Probe;
};

await withBrowser(async (h) => {
  const { page } = await h.session();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.addInitScript(() => {
    const probe: Probe = { live: {}, stacks: {} };
    (window as ProbeWindow).__lp = probe;
    // One registration per (target, type, listener, capture), as the platform
    // dedupes: a WeakMap per target holds what is registered.
    // key → registration token
    const regs = new WeakMap<EventTarget, Map<string, number>>();
    let tokens = 0;
    const keyOf = (t: EventTarget, type: string): string =>
      `${t.constructor?.name ?? "?"}:${type}`;
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const capture = (o: unknown): boolean =>
      typeof o === "boolean"
        ? o
        : !!(o as { capture?: boolean } | undefined)?.capture;
    const id = (type: string, o: unknown): string => `${type}|${capture(o)}`;
    const ids = new WeakMap<object, number>();
    let next = 1;
    const lid = (l: unknown): number => {
      if (typeof l !== "object" && typeof l !== "function") return 0;
      if (l === null) return 0;
      let n = ids.get(l);
      if (!n) ids.set(l, (n = next++));
      return n;
    };
    const dec = (target: EventTarget, type: string): void => {
      probe.live[keyOf(target, type)] =
        (probe.live[keyOf(target, type)] ?? 1) - 1;
    };
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (listener) {
        let set = regs.get(this);
        if (!set) regs.set(this, (set = new Map()));
        const k = `${id(type, options)}|${lid(listener)}`;
        if (!set.has(k)) {
          const key = keyOf(this, type);
          probe.live[key] = (probe.live[key] ?? 0) + 1;
          const stack = (new Error().stack ?? "")
            .split("\n")
            .slice(2, 9)
            .map((l) =>
              l
                .trim()
                .replace(/https?:\/\/[^/]+\//, "")
                .replace(/\?[^:)]*/, ""),
            )
            .join(" ← ");
          const s = (probe.stacks[key] ??= {});
          s[stack] = (s[stack] ?? 0) + 1;
          // The probe's own release hooks go through the saved, unwrapped
          // `add` (so they are never counted), and each only releases the
          // registration it was made for: a listener removed and re-added
          // gets a new token, which a stale hook does not match.
          const token = ++tokens;
          set.set(k, token);
          const target = this;
          const release = (): void => {
            if (set!.get(k) === token && set!.delete(k)) dec(target, type);
          };
          const signal =
            typeof options === "object" ? options.signal : undefined;
          if (signal) add.call(signal, "abort", release, { once: true });
          if (typeof options === "object" && options.once)
            add.call(this, type, release, { once: true });
        }
      }
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      const set = regs.get(this);
      const k = `${id(type, options)}|${lid(listener)}`;
      if (set?.delete(k)) dec(this, type);
      return remove.call(this, type, listener, options);
    };
  });
  await page.goto(pathUrl(path), { waitUntil: "load" });
  await page.waitForTimeout(15_000);
  const metric = async (): Promise<number> => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = (await cdp.send("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    const value = metrics.find((m) => m.name === "JSEventListeners")?.value;
    if (value === undefined)
      throw new Error("Performance.getMetrics has no JSEventListeners");
    return value;
  };
  const before = await page.evaluate(read);
  const lBefore = await metric();
  for (let i = 1; i <= minutes; i++) {
    await page.waitForTimeout(60_000);
    console.log(
      `+${i} min: JSEventListeners ${await metric()} (start ${lBefore})`,
    );
  }
  const after = await page.evaluate(read);
  const rows = Object.keys(after.live)
    .map((k) => ({
      k,
      d: (after.live[k] ?? 0) - (before.live[k] ?? 0),
      now: after.live[k] ?? 0,
    }))
    .filter((r) => r.d !== 0)
    .sort((a, b) => b.d - a.d);
  console.log("\n== net listener growth by target:type ==");
  for (const r of rows.slice(0, 15))
    console.log(`${String(r.d).padStart(6)} (now ${r.now})  ${r.k}`);
  console.log("\n== top add stacks for the 4 fastest-growing ==");
  for (const r of rows.slice(0, 4)) {
    console.log(`\n-- ${r.k}`);
    const b = before.stacks[r.k] ?? {};
    const s = Object.entries(after.stacks[r.k] ?? {})
      .map(([st, n]) => [st, n - (b[st] ?? 0)] as const)
      .filter(([, n]) => n > 0)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 4);
    for (const [st, n] of s) console.log(`${String(n).padStart(6)}× ${st}`);
  }
});
