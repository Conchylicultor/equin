import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { ClaudeSignInHost } from "./components/sign-in-host";

export { AddClaudeAccountSignIn } from "./components/add-account-sign-in";
export {
  ClaudeCodeSignInDetail,
  ClaudeCodeSignInRemedy,
  useClaudeCodeSignInHealth,
} from "./components/claude-code-sign-in";

export default {
  description:
    "Signing in to Claude from the app, shown: the Claude Code row's pieces (ClaudeCodeSignInRemedy — the Sign in split button: Claude subscription / Anthropic Console / Single sign-on — ClaudeCodeSignInDetail — the run's panel: finish in your browser, Open the page again, Signing in on another device? with the copyable page and a code field, Cancel; failed: Claude Code's words, Close, Try again — and useClaudeCodeSignInHealth, 'Signing in…' while it runs), AddClaudeAccountSignIn for the Claude accounts (a name, then the same flow; the account appears once added), and, at the root, the page a run this tab started opened in the browser and its outcome toasted, once.",
  contributions: [Core.Root({ component: ClaudeSignInHost })],
} satisfies PluginDefinition;
