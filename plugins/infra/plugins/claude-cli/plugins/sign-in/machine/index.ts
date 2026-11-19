import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  cancelClaudeSignIn,
  startClaudeSignIn,
  submitClaudeSignInCode,
} from "../core";
import { handleCancel, handleCode, handleStart } from "./internal/routes";
import { claudeSignInFlowServed } from "./internal/served";

export default {
  description:
    "Signing in to Claude from the app, desktop-only half: runs Claude Code's own auth login for the computer's own login (the bundled build, one run at a time, a new start cancelling the running one; Claude Code stores the login itself, the app never sees a credential) as a child whose sign-in page is caught by a $BROWSER shim and whose output is read live with no polling (a watched file), serves it as the claude-sign-in.flow push value (idle / waiting with the page and the page for another device / done / failed), and the start / code / cancel endpoints. A finished sign-in re-checks Claude Code (the health row flips).",
  httpRoutes: {
    [startClaudeSignIn.route]: handleStart,
    [submitClaudeSignInCode.route]: handleCode,
    [cancelClaudeSignIn.route]: handleCancel,
  },
  contributions: [...claudeSignInFlowServed.declare],
} satisfies MachinePluginDefinition;
