import { useState } from "react";
import type { CreateOption } from "@plugins/primitives/plugins/data-view/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useSourceCreators } from "../internal/use-source-creators";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const libraryMusicIcon = symbol("library-music");

/**
 * The Sonata first-run onboarding surface, shown by `SongLibrary` only when the
 * library is confirmed-empty (ready + 0 rows). A centered hero (app glyph +
 * headline + a SHORT, source-neutral subline — it never names MIDI/UG/etc.) over
 * a responsive grid of source cards.
 *
 * Every card is derived purely from `Library.Source.useContributions()` — one
 * card per source that carries a `createOption`. Clicking a card runs that
 * source's `createOption.onSelect` (create the song + `openSongImperative` →
 * straight into the player); nothing here knows what a source *is*. Adding or
 * removing a source changes the landing with zero edits here (the
 * collection–consumer separation — the whole point of the onboarding).
 *
 * A single shared `busy` flag (mirroring the data-view `CreatorsControl`
 * pattern) disables every card while any create is in-flight — one `useState`,
 * a `try/finally`, no per-card state.
 */
export function SonataOnboarding() {
  const [busy, setBusy] = useState(false);

  // Only sources with a create affordance become cards; a source that only
  // hydrates (no `createOption`) can't seed a first song, so it's skipped.
  const creators = useSourceCreators();

  const run = async (c: CreateOption): Promise<void> => {
    setBusy(true);
    try {
      await c.onSelect();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center className="h-full">
      <Inset pad="2xl">
        <Stack gap="2xl" align="center" className="w-full max-w-2xl">
          {/* Hero — app glyph, headline, and a source-neutral subline. */}
          <Stack gap="lg" align="center">
            <Center className="size-16 rounded-2xl bg-primary/10 text-primary-text">
              <Icon icon={libraryMusicIcon} className="size-8" />
            </Center>
            <Stack gap="xs" align="center">
              <Text
                as="h1"
                variant="title"
                className="text-center font-semibold"
              >
                Start your library
              </Text>
              <Text
                as="p"
                variant="body"
                tone="muted"
                className="text-center text-balance"
              >
                Add your first song to start playing — choose a source below.
              </Text>
            </Stack>
          </Stack>

          {/* Source cards, one per registered create affordance. */}
          <Grid minCellWidth="14rem" gap="md" className="w-full">
            {creators.map((c) => (
              <Card
                key={c.id}
                interactive
                role="button"
                tabIndex={busy ? -1 : 0}
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) void run(c);
                }}
                onKeyDown={(e) => {
                  if (busy) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void run(c);
                  }
                }}
                className={cn(
                  "rounded-lg p-lg",
                  busy && "pointer-events-none opacity-60",
                )}
              >
                <Stack gap="md">
                  <Center className="size-10 rounded-md bg-primary/10 text-primary-text">
                    {c.icon}
                  </Center>
                  <Stack gap="2xs">
                    <Text as="div" variant="label" className="font-semibold">
                      {c.label}
                    </Text>
                    {c.description ? (
                      <Text as="div" variant="caption" tone="muted">
                        {c.description}
                      </Text>
                    ) : null}
                  </Stack>
                </Stack>
              </Card>
            ))}
          </Grid>
        </Stack>
      </Inset>
    </Center>
  );
}
