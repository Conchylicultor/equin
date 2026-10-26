import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

const check: Check = {
  id: "endpoints:typed-web-fetches",
  description:
    'Web code must use fetchEndpoint (writes) or a live read (useLive) instead of raw fetch("/api/...")',
  async run() {
    const root = await getWorktreeRoot();

    // Match direct fetch() calls and local wrappers (jsonFetch, postJson)
    // with a literal /api/ URL. The (<[^>]*>)? handles TS generic params
    // like jsonFetch<T>("/api/...").
    const matches = await grepCode({
      root,
      pattern: /(fetch|jsonFetch|postJson)(<[^>]*>)?\(["'`]\/api\//,
      grepArg: '(fetch|jsonFetch|postJson)(<[^>]*>)?\\(["\'`]/api/',
      maskStrings: false,
    });

    // Count matching lines per file; any /web/ file with ≥1 raw /api/ fetch is
    // an offender.
    const counts = new Map<string, number>();
    for (const m of matches) {
      counts.set(m.path, (counts.get(m.path) ?? 0) + 1);
    }

    const offenders: string[] = [];

    for (const [path, count] of counts) {
      if (!path.includes("/web/")) continue;
      offenders.push(`${path}: ${count} raw fetch call(s)`);
    }

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `${offenders.length} file(s) with raw fetch("/api/...") calls:\n    ${offenders.join("\n    ")}`,
      hint: 'A write: use fetchEndpoint() / useEndpointMutation() from @plugins/infra/plugins/endpoints/web instead of raw fetch("/api/..."). A read: declare a liveValue / liveCollection and read it with useLive (plugins/network/plugins/live/CLAUDE.md). See the endpoints plugin CLAUDE.md for the pattern.',
    };
  },
};

export default check;
