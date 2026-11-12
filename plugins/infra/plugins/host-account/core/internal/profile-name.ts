import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { accountDisplayName, type HostAccount } from "./account";

/**
 * How the user is named on screen — one setting every surface that names the
 * user reads (the Pages workspace, the Claude accounts' names, an avatar
 * initial). Edited in Settings → Config.
 *
 * - `displayName` — the name to show; empty (the default) shows the OS
 *   account's full name, else its login name.
 * - `showName` — off: no surface shows a person's name at all; each reads
 *   generically ("My pages", the Claude accounts numbered) — for a screen
 *   shared or recorded.
 */
export const profileNameConfig = defineConfig({
  name: "profile-name",
  fields: {
    displayName: textField({
      label: "Your name",
      description:
        "The name equin shows for you. Leave empty to use your account's name.",
      default: "",
    }),
    showName: boolField({
      label: "Show your name",
      description:
        "Off: nothing shows a person's name — your pages read “My pages” and the Claude accounts are numbered.",
      default: true,
    }),
  },
});

/** The setting's value, as `getConfig` / `useConfig` return it. */
export interface ProfileNameSettings {
  displayName: string;
  showName: boolean;
}

/**
 * Who the user is on screen: a name, or nobody in particular (`anonymous`) —
 * a surface renders its generic form then, never a placeholder name.
 */
export type ProfileName =
  { kind: "named"; name: string } | { kind: "anonymous" };

/** The name to show for `account` under `settings`. */
export function profileName(
  account: HostAccount,
  settings: ProfileNameSettings,
): ProfileName {
  if (!settings.showName) return { kind: "anonymous" };
  const custom = settings.displayName.trim();
  return { kind: "named", name: custom || accountDisplayName(account) };
}

/** The first word of a name ("Etienne" for "Etienne Pot"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** A name's initial, upper-cased — what a one-letter avatar tile shows. */
export function nameInitial(name: string): string {
  // Spread, not `[0]`: a name starting with an astral character (an emoji, a
  // supplementary-plane letter) would otherwise yield half a surrogate pair.
  const [first] = [...firstName(name)];
  return (first ?? "?").toLocaleUpperCase();
}
