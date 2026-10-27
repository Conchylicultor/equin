import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import noRawJsonHandlers from "./no-raw-json-handlers";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

const typedHandlers: Check = {
  id: "endpoints:typed-handlers",
  description:
    "HTTP route handlers must use defineEndpoint + implement(); literal route strings in httpRoutes are forbidden for new plugins",
  async run() {
    const root = await getWorktreeRoot();

    const matches = await grepCode({
      root,
      pattern: /"(GET|POST|PUT|PATCH|DELETE) \/[^"]*"[ ]*:/,
      grepArg: '"(GET|POST|PUT|PATCH|DELETE) /[^"]*"[ ]*:',
      maskStrings: false,
      pathspecs: ["*.ts"],
    });

    const offenders: string[] = [];
    for (const m of matches) {
      if (
        !m.path.startsWith("plugins/") ||
        (!m.path.includes("/server/index.ts") &&
          !m.path.includes("/central/index.ts"))
      )
        continue;

      offenders.push(`${m.path}:${m.line}:${m.text}`);
    }

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `${offenders.length} literal route key(s) not using defineEndpoint:\n    ${offenders.join("\n    ")}`,
      hint: "Define endpoints with defineEndpoint() in core/endpoints.ts and use implement() in server handlers. See @plugins/agents for the canonical example.",
    };
  },
};

export default [typedHandlers, noRawJsonHandlers];
