import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ServerDetail } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { useServerVerified } from "@plugins/apps/plugins/deploy/plugins/health/web";
import { SshSetupSection } from "./components/ssh-setup-section";
import { SshSetupActions } from "./components/ssh-setup-actions";
import { SshProvider } from "./slots";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { SshProvider } from "./slots";
export type { SshProviderDescriptor, SshConsoleProps } from "./slots";

export default {
  description:
    "SSH setup for deploy servers: owns the whole key flow (generate / paste-and-derive / fingerprint / install command / verify the connection / replace) as a collapsible section that always renders, and decorates it with the matched SshProvider's console prose when the server's console URL identifies one.",
  contributions: [
    ServerDetail.Section({
      id: "ssh-setup",
      // The title is the SECTION's identity, so it is static and per-server
      // decoration stays out of it: the matched provider is a chip in `actions`
      // (`SshSetupActions`), where it reads as a fact about this server rather
      // than as a card whose name changes row to row. Same for the icon — a key
      // names what the section does; the provider's own icon rides its chip.
      label: "SSH key",
      column: "side",
      icon: symbol("vpn-key"),
      actions: SshSetupActions,
      // Expanded while action is needed; collapsed to one row once the
      // connection is actually proven. This only SEEDS the persisted open state
      // (the host resolves it once per mount), so it never yanks a card the user
      // has touched. Keyed on `verified`, not on holding a key — minting one is
      // the first step of the flow, not the end of it.
      //
      // A verdict still loading seeds OPEN, deliberately: the seed is read
      // once, and of the two wrong guesses, a proven server's card left open
      // costs one click, while a card collapsed over a step that needs doing
      // hides the only way forward.
      // A failed read seeds open too, for the same reason.
      useDefaultOpen: ({ server }) =>
        foldResource(useServerVerified(server), {
          loading: () => true,
          error: () => true,
          ready: (verified) => !verified,
        }),
      component: SshSetupSection,
    }),
  ],
  slots: { provider: SshProvider },
} satisfies PluginDefinition;
