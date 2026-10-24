import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import type { Audience } from "../core";

// Stored as a bool — the switch the user sees, and typed end to end (an enum
// field reads back as a plain string) — and presented as an `Audience`.
export const audienceConfig = defineConfig({
  fields: {
    developerMode: boolField({
      default: false,
      label: "Developer mode",
      description:
        "Use equin as a developer: the developer apps (Studio, Debug, Deploy, …) appear in the app gallery and launchers. Off, they stay out of the way — still reachable at their URL.",
    }),
  },
});

export function audienceOf(values: { developerMode: boolean }): Audience {
  return values.developerMode ? "developer" : "user";
}
