import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

// Until the turn ledger, this plugin kept its own record of every send in
// localStorage, one key per conversation. Nothing reads those keys now; remove
// them once per page load so they do not sit in every user's storage forever.
// Safe to delete this module once no browser can still hold one.
const LEGACY_PREFIX = "singularity:pending-turns:";

export const dropLegacyPendingTurns: NonNullable<
  PluginDefinition["register"]
>[number] = {
  register() {
    try {
      const doomed: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(LEGACY_PREFIX)) doomed.push(key);
      }
      for (const key of doomed) localStorage.removeItem(key);
    } catch (err) {
      // Storage blocked (a privacy mode, a sandboxed frame): there is nothing
      // of ours to clean there. Anything else is a bug and stays loud.
      if (err instanceof DOMException && err.name === "SecurityError") return;
      throw err;
    }
  },
};
