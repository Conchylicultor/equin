import { useState } from "react";
import type { FormEvent } from "react";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useBrowserNav } from "@plugins/apps/plugins/browser/plugins/shell/web";
import { normalizeInput } from "@plugins/apps/plugins/browser/plugins/omnibox/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const searchIcon = symbol("search");

/** "morning" / "afternoon" / "evening" for an hour of the day. */
function partOfDay(hour: number): string {
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/**
 * The start-page hero: a time-of-day greeting over a large pill search/URL
 * field. Enter applies the SAME normalization the omnibox uses (imported from
 * the omnibox barrel — single source of truth) then navigates, or goes home on
 * empty input.
 */
export function Hero() {
  const { navigate, goHome } = useBrowserNav();
  const [value, setValue] = useState("");
  const [part] = useState(() => partOfDay(new Date().getHours()));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = normalizeInput(value);
    if (result.kind === "home") {
      goHome();
    } else {
      navigate(result.url);
    }
  };

  return (
    <Stack gap="xl" align="center">
      <Text as="h1" variant="title" className="tracking-tight">
        Good {part}
        <span className="text-muted-foreground">.</span>
      </Text>
      <Line
        as="form"
        onSubmit={submit}
        className="browser-start-search w-full max-w-xl gap-sm"
      >
        <Icon
          icon={searchIcon}
          className="size-5 text-faint-foreground"
          aria-hidden
        />
        <Fill>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Search or enter address"
            aria-label="Search or enter address"
            autoComplete="off"
            spellCheck={false}
            // The start page IS the new-tab page: typing starts at once, as in every browser.
            autoFocus
            className="browser-start-search-input text-body w-full"
          />
        </Fill>
      </Line>
    </Stack>
  );
}
