/**
 * Ultimate Guitar loader: paste a UG tab URL, fetch its raw `UgTab`, and hand it
 * up as the persisted `raw`'s `tab` (with no alignment: a new sheet is aligned
 * afresh by the alignment child, which the tab save triggers).
 *
 * Unlike the chord-grid loader (which is fully controlled — `raw` *is* what's
 * typed), the source of truth here is the **fetched** `UgTab`: the URL text box
 * is local working state, but the only thing that flows up via `onRaw` is the
 * tab the server returned. Once a tab is loaded we show its `SourceLine` (song,
 * muted artist · key · capo) whose Replace expands the URL row to load another.
 *
 * Failures are surfaced visibly in a `role="alert"` red line — never swallowed.
 * That includes compile-time chord drops: chord symbols `theory.parseChordSymbol`
 * can't recognise are skipped from the synthesized Score (the bar still
 * advances), so the loader surfaces the dropped set the way the chord-grid
 * loader surfaces its `skipped` list.
 * Persistence (storing the loaded tab against a library song) is a later task,
 * so today this loader is reachable only from the in-player editor section.
 */

import { useMemo, useState } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { SourceLine } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/source-line/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  parseUgTab,
  UgParseError,
  type UgTab,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import {
  UgSourceRawSchema,
  type UgSourceRaw,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment/core";
import { fetchUgTab } from "../shared/endpoints";
import { collectUnrecognisedChords } from "./compile";

interface Props {
  raw?: unknown;
  onRaw: (raw: unknown) => void;
}

const PLACEHOLDER = "https://tabs.ultimate-guitar.com/tab/...";

/** Narrow the persisted `raw` to its `UgTab`, or `null` if absent/invalid. */
function asUgTab(raw: unknown): UgTab | null {
  const parsed = UgSourceRawSchema.safeParse(raw);
  return parsed.success ? parsed.data.tab : null;
}

export function UltimateGuitarLoader({ raw, onRaw }: Props) {
  const fetchEndpoint = useFetchEndpoint();
  const loaded = asUgTab(raw);
  // The URL box is local working state; pre-fill it with the loaded tab's URL so
  // editing/reloading is easy. The fetched `UgTab` is the persisted `raw`.
  const [url, setUrl] = useState(loaded?.urlWeb ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Replace expands the URL row below the loaded tab's line; with no tab loaded
  // yet the row is shown directly.
  const [replacing, setReplacing] = useState(false);

  // Compile feedback for the loaded tab: the chord symbols the synthesizer
  // would drop (unrecognised), plus any loud markup-parse failure. Re-derives
  // from the loaded tab the same way the chord-grid loader re-parses its text —
  // shares compile's recognise-gate so the two can't disagree. Malformed markup
  // (the same throw compile would raise) is surfaced, never swallowed.
  const { unrecognised, parseError } = useMemo<{
    unrecognised: string[];
    parseError: string | null;
  }>(() => {
    if (!loaded) return { unrecognised: [], parseError: null };
    try {
      return {
        unrecognised: collectUnrecognisedChords(parseUgTab(loaded)),
        parseError: null,
      };
    } catch (err) {
      if (err instanceof UgParseError)
        return { unrecognised: [], parseError: err.message };
      throw err;
    }
  }, [loaded]);

  // `Button` auto-pends on a promise-returning onClick (spinner + double-click
  // guard), so we return the promise to it rather than void-swallowing it.
  async function load() {
    const trimmed = url.trim();
    if (trimmed.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const tab = await fetchEndpoint(
        fetchUgTab,
        {},
        { body: { url: trimmed } },
      );
      onRaw({ tab, alignment: null } satisfies UgSourceRaw);
      setReplacing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const urlOpen = !loaded || replacing;

  const urlRow = urlOpen ? (
    <Stack direction="row" align="center" gap="sm">
      <Input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void load();
          }
        }}
        placeholder={PLACEHOLDER}
        aria-label="Ultimate Guitar URL"
        spellCheck={false}
        disabled={loading}
        autoFocus={replacing}
        className={growClass()}
      />
      <Button onClick={load} disabled={url.trim().length === 0}>
        Load
      </Button>
    </Stack>
  ) : null;

  const alerts = (
    <>
      {loaded && parseError ? (
        <Text variant="caption" tone="destructive" role="alert">
          {parseError}
        </Text>
      ) : loaded && unrecognised.length > 0 ? (
        <Text variant="caption" tone="destructive" role="alert">
          Unrecognised chords (dropped): {unrecognised.join(", ")}
        </Text>
      ) : null}
      {error ? (
        <Text variant="caption" tone="destructive" role="alert">
          {error}
        </Text>
      ) : null}
    </>
  );

  if (!loaded)
    return (
      <Stack gap="sm">
        {urlRow}
        {alerts}
      </Stack>
    );

  const subtitle = [
    loaded.artistName,
    loaded.key ? `Key ${loaded.key}` : null,
    loaded.capo > 0 ? `Capo ${loaded.capo}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <SourceLine
      title={loaded.songName}
      subtitle={subtitle}
      action={
        <Button
          variant="ghost"
          onClick={() => {
            if (replacing) {
              setUrl(loaded.urlWeb);
              setError(null);
            }
            setReplacing(!replacing);
          }}
        >
          {replacing ? "Cancel" : "Replace"}
        </Button>
      }
    >
      {urlRow}
      {alerts}
    </SourceLine>
  );
}
