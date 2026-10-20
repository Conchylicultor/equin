import type {
  ResourceUnavailable,
  ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { ClaudeCodeStatus } from "@plugins/infra/plugins/claude-cli/plugins/availability/core";
import { sameMajorMinor } from "../../core";

export interface CliDriftInputs {
  /** The system `claude` the sdk runtime runs. */
  claude: ClaudeCodeStatus;
  /** The installed Agent SDK and the CLI it was built for. */
  sdk: { sdkVersion: string; cliVersion: string };
}

/**
 * The Agent SDK row's verdict: the system `claude` against the CLI the
 * installed Agent SDK was built for. A different major.minor is `attention` —
 * the SDK's control protocol may have moved under it. When Claude Code itself
 * is missing or unreadable, its own row already says so: this one is
 * `unknown`, never a claim about versions it cannot read. Under a host without
 * the computer (both versions are read off it) the row is `unknown` with the
 * unavailable sentence: there is no version to compare, and none is made up.
 */
export function cliDriftVerdict(
  result: ResourceResult<CliDriftInputs> | ResourceUnavailable,
): HealthStatus {
  if (result.status === "unavailable") {
    return { state: "unknown", summary: result.message };
  }
  if (result.status === "loading") return { state: "unknown" };
  if (result.status === "error") {
    return { state: "unknown", summary: "Couldn't load the CLI versions" };
  }
  const { claude, sdk } = result.data;
  if (claude.kind !== "ready" && claude.kind !== "signed-out") {
    return { state: "unknown", summary: "Claude Code's version is not known" };
  }
  return sameMajorMinor(claude.version, sdk.cliVersion)
    ? {
        state: "ok",
        summary: `Claude Code v${claude.version} · SDK ${sdk.sdkVersion} (built for v${sdk.cliVersion})`,
      }
    : {
        state: "attention",
        summary: `Claude Code v${claude.version} differs from the CLI the Agent SDK ${sdk.sdkVersion} was built for (v${sdk.cliVersion}) — sdk conversations may misbehave until the two agree`,
      };
}
