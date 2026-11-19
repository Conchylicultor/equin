import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { ClaudeSignInHost } from "./components/sign-in-host";

export {
  ClaudeCodeFix,
  ClaudeCodeFixButton,
  ClaudeCodeFixWhileBlocked,
} from "./components/claude-code-fix";
export {
  ClaudeCodeSignInDetail,
  ClaudeCodeSignInRemedy,
  useClaudeCodeSignInHealth,
} from "./components/claude-code-sign-in";

export default {
  description:
    "Signing in to Claude from the app, shown: the Claude Code row's pieces (ClaudeCodeSignInRemedy — the Sign in split button: Claude subscription / Anthropic Console / Single sign-on — ClaudeCodeSignInDetail — the run's panel: finish in your browser, Open the page again, Signing in on another device? with the copyable page and a code field, Cancel; failed: Claude Code's words, Close, Try again — and useClaudeCodeSignInHealth, 'Signing in…' while it runs), ClaudeCodeFix — a Claude Code block drawn with its fix inline (what is wrong, Sign in or the open run's panel, Check again), the one way a launch surface shows one — with ClaudeCodeFixButton (a Sign in button opening it, where a launch control has no room) and ClaudeCodeFixWhileBlocked (the fix only while the computer is blocked, for a past failure's record), and, at the root, the page a run this tab started opened in the browser and its outcome toasted, once.",
  contributions: [Core.Root({ component: ClaudeSignInHost, scope: "page" })],
} satisfies PluginDefinition;
